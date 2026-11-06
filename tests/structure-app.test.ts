import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  STRUCTURE_APP_METHODS,
  STRUCTURE_APP_PROTOCOL,
  StructureJobPendingError,
  createClass,
  createPropertyDef,
  createValueList,
  parseAppResponse,
  pingStructureApp,
  runStructureJob,
  setJobPollDelaysForTests,
  structureAppStatus,
  updateClass,
} from "../src/structure-app.js";
import { MFDataType, MFilesToolError } from "../src/types.js";
import { connect } from "./helpers.js";
import { PING_OK, appOk, ext, jobDone, jobFailed, jobRunning, useStructureEnv } from "./structure-helpers.js";
import type { Route } from "./helpers.js";

before(() => setJobPollDelaysForTests([0]));
after(() => setJobPollDelaysForTests(null));
useStructureEnv();

describe("parseAppResponse", () => {
  it("accepts raw and double-encoded JSON", () => {
    assert.deepEqual(parseAppResponse(appOk({ id: 5 }), "m").result, { id: 5 });
    assert.deepEqual(parseAppResponse(JSON.stringify(appOk({ id: 5 })), "m").result, { id: 5 });
  });

  it("returns the app's diagnostics, and includes them in errors", () => {
    const parsed = parseAppResponse(
      JSON.stringify({ ok: true, result: {}, diagnostics: { elapsed_ms: 812 } }),
      "m",
    );
    assert.deepEqual(parsed.diagnostics, { elapsed_ms: 812 });
    assert.throws(
      () =>
        parseAppResponse(
          JSON.stringify({
            ok: false,
            error: "Not saving class 7.",
            diagnostics: { class_reads: ["GetObjectClassAdmin: properties [0] instead of [0, 1001]"] },
          }),
          "m",
        ),
      (err: unknown) =>
        err instanceof MFilesToolError &&
        err.message.startsWith("Not saving class 7.") &&
        err.message.includes("GetObjectClassAdmin: properties [0] instead of [0, 1001]"),
    );
  });

  it("turns ok:false into an MFilesToolError carrying the app's message", () => {
    assert.throws(
      () => parseAppResponse(JSON.stringify({ ok: false, error: "Name already in use." }), "m"),
      (err: unknown) => err instanceof MFilesToolError && err.message === "Name already in use.",
    );
  });

  it("rejects output that isn't the app's envelope", () => {
    assert.throws(
      () => parseAppResponse("<html>oops</html>", "m"),
      (err: unknown) => err instanceof MFilesToolError && err.hint.includes("vault-app/README.md"),
    );
  });
});

describe("pingStructureApp", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("posts the input as text/plain to the extension method endpoint", async () => {
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.ping),
        text: appOk({ app: "MFilesMCP", version: "1.0.0.0", protocol: STRUCTURE_APP_PROTOCOL }),
      },
    ]);
    restore = mock.restore;

    const result = await pingStructureApp(mock.client);
    assert.equal(result.installed, true);
    assert.equal((result as { compatible: boolean }).compatible, true);
    assert.equal(mock.calls[0].body, "{}");
    assert.equal(mock.calls[0].headers["Content-Type"], "text/plain; charset=utf-8");
  });

  it("reports installed:false when the method doesn't exist", async () => {
    const mock = await connect([
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.ping), status: 404, text: "" },
    ]);
    restore = mock.restore;
    const result = await pingStructureApp(mock.client);
    assert.equal(result.installed, false);
  });

  it("reports installed but not ready while vault apps are starting", async () => {
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.ping),
        status: 500,
        text: JSON.stringify({
          Message:
            "The operation can't be carried out right now because one or more vault applications are still starting up. Please try again shortly. (MFilesMCP Structure)",
        }),
      },
    ]);
    restore = mock.restore;
    const result = await pingStructureApp(mock.client);
    assert.equal(result.installed, true);
    assert.equal((result as { ready: boolean }).ready, false);
  });

  it("passes through a startup error the app recovered from", async () => {
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.ping),
        text: appOk({
          app: "MFilesMCP",
          version: "1.0.2.0",
          protocol: STRUCTURE_APP_PROTOCOL,
          vault_ready: true,
          startup_error: "InitializeTaskManager: System.Exception: boom",
        }),
      },
    ]);
    restore = mock.restore;
    const result = await pingStructureApp(mock.client);
    assert.equal((result as { startup_error: string }).startup_error, "InitializeTaskManager: System.Exception: boom");
    assert.equal((result as { vault_ready: boolean }).vault_ready, true);
    assert.ok((result as { _hint: string })._hint.includes("should work"));
  });

  it("flags a protocol mismatch", async () => {
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.ping),
        text: appOk({ app: "MFilesMCP", version: "9.0.0.0", protocol: STRUCTURE_APP_PROTOCOL + 1 }),
      },
    ]);
    restore = mock.restore;
    const result = await pingStructureApp(mock.client);
    assert.equal((result as { compatible: boolean }).compatible, false);
  });
});

// Fixture IDs are arbitrary test data.
const CONTRACT = { ID: 7, Name: "Contract", ObjectType: 104, NamePropertyDef: 0, AssociatedPropertyDefs: [{ PropertyDef: 0, Required: true }, { PropertyDef: 1001, Required: false }] };
const AGREEMENT = { ID: 8, Name: "Agreement", ObjectType: 104 };
const MEMO = { ID: 9, Name: "Memo", ObjectType: 0 };


function structureRoutes(extra: Route[] = []): Route[] {
  return [
    PING_OK,
    { path: "/REST/structure/properties/0.aspx", json: { ID: 0, Name: "Name or title", DataType: MFDataType.Text, UpdateType: 0 } },
    { path: "/REST/structure/properties/1001.aspx", json: { ID: 1001, Name: "Batch Number", DataType: MFDataType.Text, UpdateType: 0 } },
    {
      path: "/REST/structure/properties.aspx",
      json: [{ ID: 1001, Name: "Batch Number", DataType: MFDataType.Text }],
    },
    { path: "/REST/structure/classes/7.aspx", json: CONTRACT },
    { path: "/REST/structure/classes/8.aspx", json: AGREEMENT },
    { path: "/REST/structure/classes/9.aspx", json: MEMO },
    { path: "/REST/valuelists/300.aspx", json: { ID: 300, Name: "Region" } },
    ...extra,
  ];
}

const BASE_PROPERTY_ARGS = {
  aliases: [],
  addToClasses: [],
  allowDuplicateName: false,
  dryRun: false,
};

describe("createPropertyDef", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("requires a value list for lookups and refuses one otherwise", async () => {
    const mock = await connect(structureRoutes());
    restore = mock.restore;
    await assert.rejects(
      () => createPropertyDef(mock.client, { ...BASE_PROPERTY_ARGS, name: "Region", dataType: "SingleSelectLookup", allObjectTypes: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("value_list_id"),
    );
    await assert.rejects(
      () => createPropertyDef(mock.client, { ...BASE_PROPERTY_ARGS, name: "Notes", dataType: "Text", valueListId: 300, allObjectTypes: true }),
      (err: unknown) => err instanceof MFilesToolError,
    );
  });

  it("refuses a name that is already taken", async () => {
    const mock = await connect(structureRoutes());
    restore = mock.restore;
    await assert.rejects(
      () => createPropertyDef(mock.client, { ...BASE_PROPERTY_ARGS, name: "batch number", dataType: "Text", allObjectTypes: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("1001"),
    );
  });

  it("infers the object type from the classes and needs one when there are none", async () => {
    const mock = await connect(structureRoutes());
    restore = mock.restore;
    const plan = await createPropertyDef(mock.client, {
      ...BASE_PROPERTY_ARGS,
      name: "Region",
      dataType: "SingleSelectLookup",
      valueListId: 300,
      addToClasses: [{ classId: 7, required: true }, { classId: 8, required: false }],
      dryRun: true,
    });
    assert.equal((plan as { property: { defined_for_object_type: number } }).property.defined_for_object_type, 104);

    const mixed = await createPropertyDef(mock.client, {
      ...BASE_PROPERTY_ARGS,
      name: "Region",
      dataType: "Text",
      addToClasses: [{ classId: 7, required: false }, { classId: 9, required: false }],
      dryRun: true,
    });
    assert.equal((mixed as { property: { all_object_types: boolean } }).property.all_object_types, true);

    await assert.rejects(
      () => createPropertyDef(mock.client, { ...BASE_PROPERTY_ARGS, name: "Region", dataType: "Text" }),
      (err: unknown) => err instanceof MFilesToolError && err.hint.includes("defined_for_object_type_id"),
    );
  });

  it("rejects a defined-for object type that doesn't match a class", async () => {
    const mock = await connect(structureRoutes());
    restore = mock.restore;
    await assert.rejects(
      () =>
        createPropertyDef(mock.client, {
          ...BASE_PROPERTY_ARGS,
          name: "Region",
          dataType: "Text",
          definedForObjectTypeId: 0,
          addToClasses: [{ classId: 7, required: false }],
        }),
      (err: unknown) => err instanceof MFilesToolError && err.hint.includes("all_object_types"),
    );
  });

  it("creates the property, then adds it to each class through the app", async () => {
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CONTRACT, once: true },
      {
        path: "/REST/structure/classes/7.aspx",
        json: { ...CONTRACT, AssociatedPropertyDefs: [...CONTRACT.AssociatedPropertyDefs, { PropertyDef: 1200, Required: true }] },
      },
      ...structureRoutes([
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.createPropertyDef),
          text: jobDone({ id: 1200, name: "Region", data_type: MFDataType.Lookup, value_list: 300, object_type: 104 }),
        },
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.updateClass),
          text: jobDone({ class: {}, before: {} }),
          once: true,
        },
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.updateClass),
          text: jobFailed("Class is locked."),
        },
      ]),
    ]);
    restore = mock.restore;

    const result = await createPropertyDef(mock.client, {
      ...BASE_PROPERTY_ARGS,
      name: " Region ",
      dataType: "SingleSelectLookup",
      valueListId: 300,
      aliases: ["Acme.Property.Region"],
      addToClasses: [{ classId: 7, required: true }, { classId: 8, required: false }],
    });

    const appCalls = mock.calls.filter(
      (c) =>
        c.path === ext(STRUCTURE_APP_METHODS.createPropertyDef) ||
        c.path === ext(STRUCTURE_APP_METHODS.updateClass),
    );
    assert.deepEqual(JSON.parse(appCalls[0].body!), {
      name: "Region",
      data_type: MFDataType.Lookup,
      value_list: 300,
      object_type: 104,
      aliases: ["Acme.Property.Region"],
    });
    const classCall = JSON.parse(appCalls[1].body!);
    assert.deepEqual(
      { class_id: classCall.class_id, add: classCall.add, remove: classCall.remove },
      { class_id: 7, add: [{ property_id: 1200, required: true }], remove: [] },
    );
    assert.deepEqual(classCall.expected.associations, [0, 1001]);
    const classes = (result as { classes: Array<{ class_id: number; added: boolean; error?: string }> }).classes;
    assert.deepEqual(classes.map((c) => [c.class_id, c.added]), [[7, true], [8, false]]);
    assert.equal(classes[1].error, "Class is locked.");
    assert.ok((result as { _hint: string })._hint.includes("1200"));
    assert.ok(!(result as { _hint: string })._hint.includes("lost properties"));
  });
});

describe("updateClass", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const defs: Route[] = [1001, 1002, 1003].map((id) => ({
    path: `/REST/structure/properties/${id}.aspx`,
    json: { ID: id, Name: `P${id}`, DataType: MFDataType.Text },
  }));

  it("sends only real changes and reports the rest as no-ops", async () => {
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CONTRACT, once: true },
      {
        path: "/REST/structure/classes/7.aspx",
        json: {
          ...CONTRACT,
          AssociatedPropertyDefs: [
            { PropertyDef: 0, Required: true },
            { PropertyDef: 1001, Required: true },
            { PropertyDef: 1002, Required: false },
          ],
        },
      },
      ...structureRoutes(defs),
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.updateClass),
        text: jobDone({ class: { id: 7 }, before: { id: 7 } }),
      },
    ]);
    restore = mock.restore;

    const result = await updateClass(mock.client, {
      classId: 7,
      add: [
        { propertyId: 1001, required: true },
        { propertyId: 1002, required: false },
      ],
      remove: [1003],
      dryRun: false,
    });

    const sent = JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass))!.body!);
    assert.deepEqual(
      { class_id: sent.class_id, add: sent.add, remove: sent.remove },
      {
        class_id: 7,
        add: [
          { property_id: 1002, required: false },
          { property_id: 1001, required: true },
        ],
        remove: [],
      },
    );
    assert.equal(result.updated, true);
    assert.deepEqual(
      (result as { no_op: Array<{ property_id: number }> }).no_op.map((n) => n.property_id),
      [1003],
    );
    assert.equal((result as { verification?: unknown }).verification, undefined);
  });

  it("flags properties the class lost during the update and says how to restore them", async () => {
    // What app 1.0.3 did on a live vault: the new property went in, the
    // class's existing ones silently disappeared.
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CONTRACT, once: true },
      {
        path: "/REST/structure/classes/7.aspx",
        json: { ...CONTRACT, AssociatedPropertyDefs: [{ PropertyDef: 0, Required: true }, { PropertyDef: 1002, Required: false }] },
      },
      ...structureRoutes(defs),
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.updateClass),
        text: jobDone({ class: { id: 7 }, before: { id: 7 } }, { via: "permanent_vault", elapsed_ms: 116000 }),
      },
    ]);
    restore = mock.restore;

    const result = await updateClass(mock.client, {
      classId: 7,
      add: [{ propertyId: 1002, required: false }],
      remove: [],
      dryRun: false,
    });
    const verification = (result as { verification: { ok: boolean; lost_properties: unknown } }).verification;
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.lost_properties, [{ property_id: 1001, required: false }]);
    assert.ok((result as { _hint: string })._hint.includes('add=[{"property_id":1001,"required":false}]'));
    assert.deepEqual((result as { vault_app: unknown }).vault_app, { via: "permanent_vault", elapsed_ms: 116000 });
  });

  it("sends the class as REST sees it, leaving out built-ins, for the stale-read guard", async () => {
    const withBuiltIn = {
      ...CONTRACT,
      Workflow: 0,
      ForcedWorkflow: false,
      AssociatedPropertyDefs: [...CONTRACT.AssociatedPropertyDefs, { PropertyDef: 20, Required: true }],
    };
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: withBuiltIn, once: true },
      {
        path: "/REST/structure/classes/7.aspx",
        json: { ...withBuiltIn, AssociatedPropertyDefs: [...withBuiltIn.AssociatedPropertyDefs, { PropertyDef: 1002, Required: false }] },
      },
      { path: "/REST/structure/properties/20.aspx", json: { ID: 20, Name: "Created", DataType: MFDataType.Timestamp, UpdateType: 1 } },
      ...structureRoutes(defs),
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.updateClass),
        text: jobDone({ class: { id: 7 }, before: { id: 7 } }),
      },
    ]);
    restore = mock.restore;

    await updateClass(mock.client, {
      classId: 7,
      add: [{ propertyId: 1002, required: false }],
      remove: [],
      dryRun: false,
    });
    const sent = JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass))!.body!);
    assert.deepEqual(sent.expected, {
      name: "Contract",
      name_property_def: 0,
      workflow: 0,
      force_workflow: false,
      associations: [0, 1001],
    });
  });

  it("refuses structure changes when the vault app speaks an older protocol", async () => {
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.ping),
        text: appOk({ app: "MFilesMCP", version: "1.0.4.0", protocol: STRUCTURE_APP_PROTOCOL - 1 }),
      },
      ...structureRoutes(defs),
    ]);
    restore = mock.restore;

    await assert.rejects(
      () => updateClass(mock.client, { classId: 7, add: [{ propertyId: 1002, required: false }], remove: [], dryRun: false }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes(`protocol ${STRUCTURE_APP_PROTOCOL - 1}`),
    );
    assert.ok(!mock.calls.some((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass)));
  });

  it("refuses to remove the class's name property", async () => {
    const mock = await connect([
      ...structureRoutes(defs),
      { path: "/REST/structure/properties/0.aspx", json: { ID: 0, Name: "Name or title", DataType: MFDataType.Text } },
    ]);
    restore = mock.restore;
    await assert.rejects(
      () => updateClass(mock.client, { classId: 7, add: [], remove: [0], dryRun: false }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("name property"),
    );
  });
});

describe("createValueList", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("de-duplicates items and surfaces the ones the app couldn't add", async () => {
    const mock = await connect([
      PING_OK,
      { path: "/REST/valuelists.aspx", json: [{ ID: 1, Name: "Customer", RealObjectType: true }] },
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.createValueList),
        text: jobDone({
          id: 310,
          name_singular: "Region",
          name_plural: "Region",
          items: [{ id: 1, name: "North" }],
          failed_items: [{ name: "South", error: "boom" }],
        }),
      },
    ]);
    restore = mock.restore;

    const result = await createValueList(mock.client, {
      nameSingular: "Region",
      aliases: [],
      items: ["North", " north ", "South", ""],
      allowDuplicateName: false,
      dryRun: false,
    });
    assert.deepEqual(JSON.parse(mock.calls.at(-1)!.body!).items, ["North", "South"]);
    assert.equal(JSON.parse(mock.calls.at(-1)!.body!).name_plural, "Region");
    assert.ok((result as { _hint: string })._hint.includes("1 item(s) failed"));
  });
});

describe("runStructureJob", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("polls the job until it finishes", async () => {
    const mock = await connect([
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.createValueList), text: jobRunning("j9", "queued") },
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.getJob), text: jobRunning("j9"), once: true },
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.getJob), text: jobDone({ id: 1 }, { channel: "admin session" }) },
    ]);
    restore = mock.restore;
    const { result, diagnostics } = await runStructureJob(mock.client, STRUCTURE_APP_METHODS.createValueList, { name_singular: "X" });
    assert.deepEqual(result, { id: 1 });
    assert.deepEqual(diagnostics, { channel: "admin session" });
    const polls = mock.calls.filter((c) => c.path === ext(STRUCTURE_APP_METHODS.getJob));
    assert.equal(polls.length, 2);
    assert.deepEqual(JSON.parse(polls[0].body!), { job_id: "j9" });
  });

  it("stops waiting after MFILES_STRUCTURE_WAIT_SECONDS and hands back the job ID", async () => {
    process.env.MFILES_STRUCTURE_WAIT_SECONDS = "0.05";
    const mock = await connect([
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.createValueList), text: jobRunning("j10") },
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.getJob), text: jobRunning("j10") },
    ]);
    restore = mock.restore;
    setJobPollDelaysForTests([10]);
    try {
      await assert.rejects(
        () => runStructureJob(mock.client, STRUCTURE_APP_METHODS.createValueList, {}),
        (err: unknown) =>
          err instanceof StructureJobPendingError &&
          err.hint.includes('job_id="j10"') &&
          err.hint.includes("Don't resubmit"),
      );
    } finally {
      setJobPollDelaysForTests([0]);
    }
  });

  it("retries once with MFILES_USERNAME/MFILES_PASSWORD when the app's own login failed", async () => {
    process.env.MFILES_USERNAME = "admin";
    process.env.MFILES_PASSWORD = "secret";
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.updateClass),
        text: jobFailed("Couldn't open an administrative session.", "admin_login_failed"),
        once: true,
      },
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.updateClass), text: jobDone({ ok: 1 }) },
    ]);
    restore = mock.restore;
    await runStructureJob(mock.client, STRUCTURE_APP_METHODS.updateClass, { class_id: 7 });
    const submits = mock.calls.filter((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass)).map((c) => JSON.parse(c.body!));
    assert.equal(submits.length, 2);
    assert.equal(submits[0].login, undefined);
    assert.deepEqual(submits[1].login, { username: "admin", password: "secret" });
  });

  it("never sends credentials with MFILES_STRUCTURE_LOGIN=windows", async () => {
    process.env.MFILES_USERNAME = "admin";
    process.env.MFILES_PASSWORD = "secret";
    process.env.MFILES_STRUCTURE_LOGIN = "windows";
    const mock = await connect([
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.updateClass),
        text: jobFailed("Couldn't open an administrative session.", "admin_login_failed"),
      },
    ]);
    restore = mock.restore;
    await assert.rejects(
      () => runStructureJob(mock.client, STRUCTURE_APP_METHODS.updateClass, {}),
      (err: unknown) => err instanceof MFilesToolError && err.hint.includes("MFILES_STRUCTURE_LOGIN=windows"),
    );
    assert.equal(mock.calls.filter((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass)).length, 1);
  });

  it("passes MFILES_STRUCTURE_SERVER_ENDPOINT to the app", async () => {
    process.env.MFILES_STRUCTURE_SERVER_ENDPOINT = "ncacn_ip_tcp:localhost:12266";
    const mock = await connect([
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.read), text: jobDone({}) },
    ]);
    restore = mock.restore;
    await runStructureJob(mock.client, STRUCTURE_APP_METHODS.read, { kind: "class", id: 7 });
    assert.deepEqual(JSON.parse(mock.calls[0].body!).server_endpoints, [
      { protocol: "ncacn_ip_tcp", address: "localhost", port: "12266" },
    ]);
  });
});

describe("structureAppStatus", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("reports whether the app could open its admin session", async () => {
    const mock = await connect([
      PING_OK,
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.checkAdminSession),
        text: jobDone({ admin_session: { ok: true, login: "app's Windows account (NT AUTHORITY\\SYSTEM)", account: "SYSTEM" } }),
      },
    ]);
    restore = mock.restore;
    const status = await structureAppStatus(mock.client);
    assert.equal((status as { admin_session: { ok: boolean } }).admin_session.ok, true);
    assert.ok((status as { _hint: string })._hint.startsWith("Ready."));
  });

  it("turns a failed login into admin_session.ok=false instead of an error", async () => {
    const mock = await connect([
      PING_OK,
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.checkAdminSession),
        text: jobFailed("Couldn't open an administrative session to the vault: Login failed.", "admin_login_failed"),
      },
    ]);
    restore = mock.restore;
    const status = await structureAppStatus(mock.client);
    const session = (status as { admin_session: { ok: boolean; error: string } }).admin_session;
    assert.equal(session.ok, false);
    assert.ok(session.error.includes("Login failed"));
  });
});

describe("updateClass settings", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("sets a workflow and checks it over REST afterwards", async () => {
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CONTRACT, once: true },
      { path: "/REST/structure/classes/7.aspx", json: { ...CONTRACT, Workflow: 55, ForcedWorkflow: true } },
      { path: "/REST/structure/workflows/55.aspx", json: { ID: 55, Name: "Approval" } },
      ...structureRoutes(),
      {
        method: "POST",
        path: ext(STRUCTURE_APP_METHODS.updateClass),
        text: jobDone({ class: { id: 7, workflow: 55 }, before: { id: 7, workflow: null } }),
      },
    ]);
    restore = mock.restore;
    const result = await updateClass(mock.client, {
      classId: 7,
      add: [],
      remove: [],
      workflowId: 55,
      forceWorkflow: true,
      dryRun: false,
    });
    const sent = JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass))!.body!);
    assert.equal(sent.workflow, 55);
    assert.equal(sent.force_workflow, true);
    assert.deepEqual(sent.add, []);
    assert.deepEqual((result as { settings: { workflow: unknown } }).settings.workflow, { from: null, to: { id: 55, name: "Approval" } });
    assert.equal((result as { verification?: unknown }).verification, undefined);
  });

  it("removes a workflow with workflowId null, and refuses force without one", async () => {
    const withWorkflow = { ...CONTRACT, Workflow: 55, ForcedWorkflow: false };
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: withWorkflow, once: true },
      { path: "/REST/structure/classes/7.aspx", json: { ...withWorkflow, Workflow: 0 } },
      ...structureRoutes(),
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.updateClass), text: jobDone({ class: {}, before: {} }) },
    ]);
    restore = mock.restore;
    await updateClass(mock.client, { classId: 7, add: [], remove: [], workflowId: null, dryRun: false });
    const sent = JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass))!.body!);
    assert.equal(sent.workflow, 0);
    await assert.rejects(
      () => updateClass(mock.client, { classId: 7, add: [], remove: [], workflowId: null, forceWorkflow: true, dryRun: false }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("force_workflow"),
    );
  });

  it("refuses server-maintained properties and non-Text name properties", async () => {
    const mock = await connect([
      { path: "/REST/structure/properties/20.aspx", json: { ID: 20, Name: "Created", DataType: MFDataType.Timestamp, UpdateType: 1 } },
      { path: "/REST/structure/properties/1100.aspx", json: { ID: 1100, Name: "Amount", DataType: MFDataType.Floating, UpdateType: 0 } },
      ...structureRoutes(),
    ]);
    restore = mock.restore;
    await assert.rejects(
      () => updateClass(mock.client, { classId: 7, add: [{ propertyId: 20, required: false }], remove: [], dryRun: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("maintains"),
    );
    await assert.rejects(
      () => updateClass(mock.client, { classId: 7, add: [], remove: [], namePropertyId: 1100, dryRun: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("must be Text"),
    );
  });
});

describe("createClass", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const routes = (extra: Route[] = []) =>
    structureRoutes([
      { path: "/REST/structure/objecttypes/104.aspx", json: { ID: 104, Name: "Contract", RealObjectType: true } },
      { path: "/REST/structure/objecttypes/300.aspx", json: { ID: 300, Name: "Region", RealObjectType: false } },
      { path: "/REST/structure/classes.aspx", json: [CONTRACT, AGREEMENT, MEMO] },
      ...extra,
    ]);

  it("refuses value lists and duplicate names", async () => {
    const mock = await connect(routes());
    restore = mock.restore;
    const base = { properties: [], forceWorkflow: false, aliases: [], allowDuplicateName: false, dryRun: true };
    await assert.rejects(
      () => createClass(mock.client, { ...base, objectTypeId: 300, name: "X" }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("value list"),
    );
    await assert.rejects(
      () => createClass(mock.client, { ...base, objectTypeId: 104, name: "agreement" }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("already has a class"),
    );
  });

  it("sends the class with Name or title as its name property by default", async () => {
    const mock = await connect(
      routes([
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.createClass),
          text: jobDone({ class: { id: 77, name: "Lease", object_type: 104, associated_property_defs: [] }, warning: null }),
        },
        {
          path: "/REST/structure/classes/77.aspx",
          json: { ID: 77, Name: "Lease", ObjectType: 104, AssociatedPropertyDefs: [{ PropertyDef: 0, Required: true }, { PropertyDef: 1001, Required: true }] },
        },
      ]),
    );
    restore = mock.restore;
    const result = await createClass(mock.client, {
      objectTypeId: 104,
      name: " Lease ",
      properties: [{ propertyId: 1001, required: true }],
      forceWorkflow: false,
      aliases: ["Acme.Class.Lease"],
      allowDuplicateName: false,
      dryRun: false,
    });
    const sent = JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.createClass))!.body!);
    assert.deepEqual(sent, {
      object_type: 104,
      name: "Lease",
      name_property_def: 0,
      properties: [{ property_id: 1001, required: true }],
      aliases: ["Acme.Class.Lease"],
    });
    assert.equal((result as { created: boolean }).created, true);
    assert.equal((result as { _hint?: string })._hint, undefined);
  });
});

describe("createClass verification", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("says which requested properties REST doesn't show on the new class", async () => {
    const mock = await connect(
      structureRoutes([
        { path: "/REST/structure/objecttypes/104.aspx", json: { ID: 104, Name: "Contract", RealObjectType: true } },
        { path: "/REST/structure/classes.aspx", json: [CONTRACT] },
        { method: "POST", path: ext(STRUCTURE_APP_METHODS.createClass), text: jobDone({ class: { id: 78 }, warning: null }) },
        { path: "/REST/structure/classes/78.aspx", json: { ID: 78, Name: "Lease", ObjectType: 104, AssociatedPropertyDefs: [{ PropertyDef: 0, Required: true }] } },
      ]),
    );
    restore = mock.restore;
    const result = await createClass(mock.client, {
      objectTypeId: 104,
      name: "Lease",
      properties: [{ propertyId: 1001, required: false }],
      forceWorkflow: false,
      aliases: [],
      allowDuplicateName: false,
      dryRun: false,
    });
    assert.ok((result as { _hint: string })._hint.includes("doesn't show properties 1001"));
  });
});

describe("expected class state", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("reads the force-workflow flag from HasForcedWorkflow, as MFWS sends it", async () => {
    const forced = { ...CONTRACT, Workflow: 55, HasForcedWorkflow: true };
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: forced },
      ...structureRoutes(),
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.updateClass), text: jobDone({ class: {}, before: {} }) },
    ]);
    restore = mock.restore;
    const plan = await updateClass(mock.client, { classId: 7, add: [], remove: [], forceWorkflow: false, dryRun: true });
    assert.deepEqual((plan as { settings: { force_workflow: unknown } }).settings.force_workflow, { from: true, to: false });
    await updateClass(mock.client, { classId: 7, add: [], remove: [], forceWorkflow: false, dryRun: false });
    const sent = JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.updateClass))!.body!);
    assert.equal(sent.expected.force_workflow, true);
  });
});

describe("updateClass while M-Files keeps the save open", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("reports success when REST already shows the change", async () => {
    process.env.MFILES_STRUCTURE_WAIT_SECONDS = "0.05";
    const mock = await connect([
      { path: "/REST/structure/classes/7.aspx", json: CONTRACT, once: true },
      { path: "/REST/structure/classes/7.aspx", json: CONTRACT, once: true },
      {
        path: "/REST/structure/classes/7.aspx",
        json: { ...CONTRACT, AssociatedPropertyDefs: [...CONTRACT.AssociatedPropertyDefs, { PropertyDef: 1002, Required: true }] },
      },
      { path: "/REST/structure/properties/1002.aspx", json: { ID: 1002, Name: "P1002", DataType: MFDataType.Text } },
      ...structureRoutes(),
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.updateClass), text: jobRunning("slow") },
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.getJob), text: jobRunning("slow") },
    ]);
    restore = mock.restore;
    setJobPollDelaysForTests([10]);
    try {
      const result = await updateClass(mock.client, { classId: 7, add: [{ propertyId: 1002, required: true }], remove: [], dryRun: false });
      assert.equal((result as { updated: boolean }).updated, true);
      assert.ok((result as { _hint: string })._hint.includes("REST shows the change"));
    } finally {
      setJobPollDelaysForTests([0]);
    }
  });

  it("still says it's running when REST doesn't show the change yet", async () => {
    process.env.MFILES_STRUCTURE_WAIT_SECONDS = "0.05";
    const mock = await connect([
      { path: "/REST/structure/properties/1002.aspx", json: { ID: 1002, Name: "P1002", DataType: MFDataType.Text } },
      ...structureRoutes(),
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.updateClass), text: jobRunning("slow2") },
      { method: "POST", path: ext(STRUCTURE_APP_METHODS.getJob), text: jobRunning("slow2") },
    ]);
    restore = mock.restore;
    setJobPollDelaysForTests([10]);
    try {
      await assert.rejects(
        () => updateClass(mock.client, { classId: 7, add: [{ propertyId: 1002, required: true }], remove: [], dryRun: false }),
        (err: unknown) => err instanceof StructureJobPendingError,
      );
    } finally {
      setJobPollDelaysForTests([0]);
    }
  });
});
