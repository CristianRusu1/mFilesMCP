import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createObject,
  createValueListItem,
  updateObjectProperties,
} from "../src/object-writes.js";
import { MFDataType, MFUpdateType, MFilesToolError } from "../src/types.js";
import { callLines, connect } from "./helpers.js";
import type { Route } from "./helpers.js";

// Fixture IDs are arbitrary test data; nothing in src/ depends on them.
const BATCH = { ID: 1001, Name: "Batch Number", DataType: MFDataType.Text };
const REVIEWERS = {
  ID: 1050,
  Name: "Reviewers",
  DataType: MFDataType.MultiSelectLookup,
  ValueList: 200,
};

function objectVersion(version: number, extra: Record<string, unknown> = {}) {
  return {
    ObjVer: { ID: 42, Type: 0, Version: version },
    Title: "Doc",
    Class: 7,
    ObjectCheckedOut: false,
    ObjectCheckedOutToThisUser: false,
    ...extra,
  };
}

const CURRENT_PROPERTIES = [
  {
    PropertyDef: 0,
    TypedValue: { DataType: MFDataType.Text, HasValue: true, Value: "Doc", DisplayValue: "Doc" },
  },
  {
    PropertyDef: REVIEWERS.ID,
    TypedValue: {
      DataType: MFDataType.MultiSelectLookup,
      HasValue: true,
      DisplayValue: "Alice",
      Lookups: [{ Item: 7, Version: 2, DisplayValue: "Alice" }],
    },
  },
];

function baseRoutes(current: Record<string, unknown> = {}): Route[] {
  return [
    {
      path: "/REST/objects/0/42/latest.aspx",
      json: objectVersion(5, { Properties: CURRENT_PROPERTIES, ...current }),
    },
    { path: "/REST/structure/properties/1001.aspx", json: BATCH },
    { path: "/REST/structure/properties/1050.aspx", json: REVIEWERS },
    {
      path: /^\/REST\/valuelists\/200\/items\.aspx\?filter=Bob$/,
      json: { Items: [{ ID: 8, Name: "Bob" }, { ID: 9, Name: "Bobby" }] },
    },
  ];
}

const AFTER_PROPERTIES = [
  {
    PropertyDef: BATCH.ID,
    TypedValue: { DataType: MFDataType.Text, HasValue: true, Value: "B-17", DisplayValue: "B-17" },
  },
  {
    PropertyDef: REVIEWERS.ID,
    TypedValue: {
      DataType: MFDataType.MultiSelectLookup,
      HasValue: true,
      DisplayValue: "Alice; Bob",
      Lookups: [
        { Item: 7, Version: -1, DisplayValue: "Alice" },
        { Item: 8, Version: -1, DisplayValue: "Bob" },
      ],
    },
  },
];

const SET_ARGS = {
  objectType: 0,
  objectId: 42,
  set: [
    { property: BATCH.ID, value: "B-17" },
    { property: REVIEWERS.ID, value: ["Bob"], append: true },
  ],
  remove: [],
};

describe("updateObjectProperties", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("checks out, sets every property in one POST, then checks in", async () => {
    const mock = await connect([
      ...baseRoutes(),
      {
        method: "PUT",
        path: "/REST/objects/0/42/latest/checkedout.aspx",
        json: objectVersion(6, { ObjectCheckedOut: true, ObjectCheckedOutToThisUser: true }),
      },
      {
        method: "POST",
        path: "/REST/objects/0/42/6/properties.aspx",
        json: objectVersion(6, { Properties: AFTER_PROPERTIES }),
      },
      { method: "PUT", path: "/REST/objects/0/42/6/checkedout.aspx", json: objectVersion(6) },
    ]);
    restore = mock.restore;

    const result = await updateObjectProperties(mock.client, { ...SET_ARGS, dryRun: false });

    assert.deepEqual(callLines(mock.calls), [
      "GET /REST/objects/0/42/latest.aspx?include=properties",
      "GET /REST/structure/properties/1001.aspx",
      "GET /REST/structure/properties/1050.aspx",
      "GET /REST/valuelists/200/items.aspx?filter=Bob",
      "PUT /REST/objects/0/42/latest/checkedout.aspx",
      "POST /REST/objects/0/42/6/properties.aspx",
      "PUT /REST/objects/0/42/6/checkedout.aspx",
    ]);
    assert.deepEqual(JSON.parse(mock.calls[4].body!), { Value: 2 });
    assert.deepEqual(JSON.parse(mock.calls[5].body!), [
      {
        PropertyDef: BATCH.ID,
        TypedValue: { DataType: MFDataType.Text, HasValue: true, Value: "B-17" },
      },
      {
        PropertyDef: REVIEWERS.ID,
        TypedValue: {
          DataType: MFDataType.MultiSelectLookup,
          HasValue: true,
          Lookups: [
            { Item: 7, Version: -1 },
            { Item: 8, Version: -1 },
          ],
        },
      },
    ]);
    assert.deepEqual(JSON.parse(mock.calls[6].body!), { Value: 0 });

    assert.equal(result.updated, true);
    assert.equal((result as { checked_in: boolean }).checked_in, true);
    const changes = (result as { changes: Array<Record<string, unknown>> }).changes;
    assert.deepEqual(changes[1].before, {
      display_value: "Alice",
      lookups: [{ id: 7, name: "Alice" }],
    });
    assert.deepEqual(changes[1].after, {
      display_value: "Alice; Bob",
      lookups: [
        { id: 7, name: "Alice" },
        { id: 8, name: "Bob" },
      ],
    });
  });

  it("undoes the checkout when a write fails, so nothing is half-saved", async () => {
    const mock = await connect([
      ...baseRoutes(),
      {
        method: "PUT",
        path: "/REST/objects/0/42/latest/checkedout.aspx",
        json: objectVersion(6, { ObjectCheckedOut: true, ObjectCheckedOutToThisUser: true }),
      },
      {
        method: "POST",
        path: "/REST/objects/0/42/6/properties.aspx",
        status: 500,
        text: JSON.stringify({ Status: 500, Message: "Batch Number is not valid." }),
      },
      { method: "DELETE", path: "/REST/objects/0/42/6.aspx", status: 204 },
    ]);
    restore = mock.restore;

    await assert.rejects(
      () => updateObjectProperties(mock.client, { ...SET_ARGS, dryRun: false }),
      (err: unknown) =>
        err instanceof MFilesToolError &&
        err.message.includes("Batch Number is not valid.") &&
        err.hint.startsWith("Nothing was saved"),
    );
    const lines = callLines(mock.calls);
    assert.equal(lines.at(-1), "DELETE /REST/objects/0/42/6.aspx");
    assert.ok(!lines.includes("PUT /REST/objects/0/42/6/checkedout.aspx"));
  });

  it("refuses to touch an object checked out to someone else", async () => {
    const mock = await connect(
      baseRoutes({
        ObjectCheckedOut: true,
        ObjectCheckedOutToThisUser: false,
        CheckedOutToUserName: "carol",
      }),
    );
    restore = mock.restore;

    await assert.rejects(
      () => updateObjectProperties(mock.client, { ...SET_ARGS, dryRun: false }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("carol"),
    );
    assert.deepEqual(callLines(mock.calls), [
      "GET /REST/objects/0/42/latest.aspx?include=properties",
    ]);
  });

  it("writes nothing on a dry run", async () => {
    const mock = await connect(baseRoutes());
    restore = mock.restore;

    const result = await updateObjectProperties(mock.client, { ...SET_ARGS, dryRun: true });

    assert.ok(mock.calls.every((c) => c.method === "GET"));
    assert.equal((result as { dry_run: boolean }).dry_run, true);
    const planned = (result as { planned_changes: Array<Record<string, unknown>> })
      .planned_changes;
    assert.deepEqual(planned[1].new_value, [
      { id: 7, name: "Alice" },
      { id: 8, name: "Bob" },
    ]);
  });

  it("edits in place and leaves the checkout alone when it is already ours", async () => {
    const mock = await connect([
      ...baseRoutes({ ObjVer: { ID: 42, Type: 0, Version: 6 }, ObjectCheckedOut: true, ObjectCheckedOutToThisUser: true }),
      {
        method: "POST",
        path: "/REST/objects/0/42/6/properties.aspx",
        json: objectVersion(6, { Properties: AFTER_PROPERTIES }),
      },
    ]);
    restore = mock.restore;

    const result = await updateObjectProperties(mock.client, {
      objectType: 0,
      objectId: 42,
      set: [{ property: BATCH.ID, value: "B-17" }],
      remove: [],
      dryRun: false,
    });

    assert.ok(!mock.calls.some((c) => c.path.includes("checkedout")));
    assert.equal((result as { checked_in: boolean }).checked_in, false);
  });

  it("removes properties that are present and skips those that aren't", async () => {
    const mock = await connect([
      ...baseRoutes(),
      {
        method: "PUT",
        path: "/REST/objects/0/42/latest/checkedout.aspx",
        json: objectVersion(6, { ObjectCheckedOut: true, ObjectCheckedOutToThisUser: true }),
      },
      {
        method: "DELETE",
        path: "/REST/objects/0/42/6/properties/1050.aspx",
        json: objectVersion(6, { Properties: [CURRENT_PROPERTIES[0]] }),
      },
      { method: "PUT", path: "/REST/objects/0/42/6/checkedout.aspx", json: objectVersion(6) },
    ]);
    restore = mock.restore;

    const result = await updateObjectProperties(mock.client, {
      objectType: 0,
      objectId: 42,
      set: [],
      remove: [REVIEWERS.ID, BATCH.ID],
      dryRun: false,
    });

    assert.ok(callLines(mock.calls).includes("DELETE /REST/objects/0/42/6/properties/1050.aspx"));
    assert.ok(!mock.calls.some((c) => c.path.includes("/properties/1001.aspx") && c.method === "DELETE"));
    assert.deepEqual(
      (result as { skipped: Array<{ property_id: number }> }).skipped.map((s) => s.property_id),
      [BATCH.ID],
    );
  });

  it("resolves property names to IDs and rejects ambiguous ones", async () => {
    const mock = await connect([
      ...baseRoutes(),
      {
        path: "/REST/structure/properties.aspx",
        json: [BATCH, REVIEWERS, { ID: 1077, Name: "batch number", DataType: MFDataType.Text }],
      },
    ]);
    restore = mock.restore;

    await assert.rejects(
      () =>
        updateObjectProperties(mock.client, {
          objectType: 0,
          objectId: 42,
          set: [{ property: "Batch Number", value: "x" }],
          remove: [],
          dryRun: true,
        }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("1001, 1077"),
    );
  });
});

describe("createObject", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const CLASS = {
    ID: 7,
    Name: "Contract",
    ObjectType: 104,
    NamePropertyDef: 0,
    AssociatedPropertyDefs: [
      { PropertyDef: 0, Required: true },
      { PropertyDef: 100, Required: true },
      { PropertyDef: 1001, Required: true },
      { PropertyDef: 1099, Required: true },
      // Classes list server-maintained built-ins as required too.
      { PropertyDef: 20, Required: true },
      { PropertyDef: 22, Required: true },
    ],
  };
  const NAME = { ID: 0, Name: "Name or title", DataType: MFDataType.Text };
  const AUTO_NUMBER = { ID: 1099, Name: "Contract No", DataType: MFDataType.Text, AutomaticValueType: 1 };
  const CREATED = { ID: 20, Name: "Created", DataType: MFDataType.Timestamp, Predefined: true, UpdateType: MFUpdateType.ServerAuto };
  const SINGLE_FILE = { ID: 22, Name: "Single file", DataType: MFDataType.Boolean, Predefined: true, UpdateType: MFUpdateType.ClientAuto };
  const BUILT_IN_ROUTES: Route[] = [
    { path: "/REST/structure/properties/20.aspx", json: CREATED },
    { path: "/REST/structure/properties/22.aspx", json: SINGLE_FILE },
  ];

  it("rejects a class that belongs to another object type", async () => {
    const mock = await connect([{ path: "/REST/structure/classes/7.aspx", json: CLASS }]);
    restore = mock.restore;
    await assert.rejects(
      () => createObject(mock.client, { objectType: 0, classId: 7, properties: [], dryRun: false }),
      (err: unknown) => err instanceof MFilesToolError && err.hint.includes("object_type_id=104"),
    );
  });

  it("lists missing required properties, ignoring automatic and server-maintained ones", async () => {
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CLASS },
      { path: "/REST/structure/properties/0.aspx", json: NAME },
      { path: "/REST/structure/properties/1001.aspx", json: BATCH },
      { path: "/REST/structure/properties/1099.aspx", json: AUTO_NUMBER },
      ...BUILT_IN_ROUTES,
    ]);
    restore = mock.restore;

    const result = await createObject(mock.client, {
      objectType: 104,
      classId: 7,
      properties: [{ property: 0, value: "Supply agreement" }],
      dryRun: true,
    });
    assert.deepEqual(
      (result as { missing_required_properties: Array<{ property_id: number }> })
        .missing_required_properties.map((m) => m.property_id),
      [BATCH.ID],
    );
  });

  it("refuses to set a property the server maintains itself", async () => {
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CLASS },
      ...BUILT_IN_ROUTES,
    ]);
    restore = mock.restore;
    await assert.rejects(
      () =>
        createObject(mock.client, {
          objectType: 104,
          classId: 7,
          properties: [{ property: 20, value: "2024-01-01T00:00:00Z" }],
          dryRun: true,
        }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("maintained by M-Files"),
    );
  });

  it("posts the class lookup first, followed by the given properties", async () => {
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CLASS },
      { path: "/REST/structure/properties/0.aspx", json: NAME },
      { path: "/REST/structure/properties/1001.aspx", json: BATCH },
      { path: "/REST/structure/properties/1099.aspx", json: AUTO_NUMBER },
      ...BUILT_IN_ROUTES,
      {
        method: "POST",
        path: "/REST/objects/104.aspx",
        json: { ObjVer: { ID: 900, Type: 104, Version: 1 }, Title: "Supply agreement", Class: 7 },
      },
    ]);
    restore = mock.restore;

    const result = await createObject(mock.client, {
      objectType: 104,
      classId: 7,
      properties: [
        { property: 0, value: "Supply agreement" },
        { property: BATCH.ID, value: "B-1" },
      ],
      dryRun: false,
    });
    const body = JSON.parse(mock.calls.at(-1)!.body!);
    assert.deepEqual(body.PropertyValues[0], {
      PropertyDef: 100,
      TypedValue: { DataType: MFDataType.Lookup, HasValue: true, Lookup: { Item: 7, Version: -1 } },
    });
    assert.deepEqual(
      body.PropertyValues.map((p: { PropertyDef: number }) => p.PropertyDef),
      [100, 0, BATCH.ID],
    );
    assert.deepEqual(body.Files, []);
    assert.equal((result as { object: { id: number } }).object.id, 900);
  });
});

describe("createValueListItem", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("refuses object types", async () => {
    const mock = await connect([
      { path: "/REST/valuelists/104.aspx", json: { ID: 104, Name: "Customer", RealObjectType: true } },
    ]);
    restore = mock.restore;
    await assert.rejects(
      () =>
        createValueListItem(mock.client, {
          valueListId: 104,
          name: "ACME",
          allowDuplicate: false,
          dryRun: false,
        }),
      (err: unknown) => err instanceof MFilesToolError && err.hint.includes("mfiles_create_object"),
    );
  });

  it("returns the existing item instead of creating a duplicate", async () => {
    const mock = await connect([
      { path: "/REST/valuelists/300.aspx", json: { ID: 300, Name: "Status" } },
      { path: "/REST/valuelists/300/items.aspx", json: { Items: [{ ID: 3, Name: "Approved" }] } },
    ]);
    restore = mock.restore;

    const result = await createValueListItem(mock.client, {
      valueListId: 300,
      name: " approved ",
      allowDuplicate: false,
      dryRun: false,
    });
    assert.equal(result.created, false);
    assert.ok(!mock.calls.some((c) => c.method === "POST"));
  });

  it("creates the item when the name is new", async () => {
    const mock = await connect([
      { path: "/REST/valuelists/300.aspx", json: { ID: 300, Name: "Status" } },
      { path: "/REST/valuelists/300/items.aspx", json: { Items: [] } },
      {
        method: "POST",
        path: "/REST/valuelists/300/items.aspx",
        json: { ID: 4, Name: "Rejected", ValueListID: 300 },
      },
    ]);
    restore = mock.restore;

    const result = await createValueListItem(mock.client, {
      valueListId: 300,
      name: "Rejected",
      allowDuplicate: false,
      dryRun: false,
    });
    assert.deepEqual(JSON.parse(mock.calls.at(-1)!.body!), {
      Name: "Rejected",
      ValueListID: 300,
      HasOwner: false,
      OwnerID: 0,
      HasParent: false,
      ParentID: 0,
    });
    assert.deepEqual((result as { item: unknown }).item, { id: 4, name: "Rejected" });
  });
});
