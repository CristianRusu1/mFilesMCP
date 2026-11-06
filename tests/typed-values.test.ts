import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toTypedValue, emptyTypedValue } from "../src/typed-values.js";
import type { LookupResolver } from "../src/typed-values.js";
import { MFDataType, MFilesToolError } from "../src/types.js";
import type { MFilesPropertyDef } from "../src/types.js";

function def(DataType: number, extra: Partial<MFilesPropertyDef> = {}): MFilesPropertyDef {
  return { ID: 1001, Name: "Prop", DataType, ...extra };
}

const noLookups: LookupResolver = async () => {
  throw new Error("resolver should not be called");
};

const byName: LookupResolver = async (valueListId, name) => {
  const items: Record<string, number> = { bob: 8, carol: 9 };
  const id = items[name.toLowerCase()];
  if (!id) throw new MFilesToolError(`No item named "${name}"`, "hint");
  return { ID: id, Name: name, ValueListID: valueListId };
};

async function typed(dataType: number, value: unknown, extra?: Partial<MFilesPropertyDef>) {
  return (await toTypedValue(def(dataType, extra), value as never, byName)).typedValue;
}

async function rejectsWithToolError(p: Promise<unknown>) {
  await assert.rejects(p, (err: unknown) => err instanceof MFilesToolError);
}

describe("toTypedValue", () => {
  it("stringifies text values", async () => {
    assert.deepEqual(await typed(MFDataType.Text, 42), {
      DataType: MFDataType.Text,
      HasValue: true,
      Value: "42",
    });
    assert.equal((await typed(MFDataType.MultiLineText, "a\nb")).Value, "a\nb");
  });

  it("parses integers and rejects decimals or out-of-range values", async () => {
    assert.equal((await typed(MFDataType.Integer, "42")).Value, 42);
    await rejectsWithToolError(typed(MFDataType.Integer, 3.5));
    await rejectsWithToolError(typed(MFDataType.Integer, 2 ** 31));
    assert.equal((await typed(MFDataType.Integer64, 2 ** 40)).Value, 2 ** 40);
  });

  it("parses floats and rejects non-numbers", async () => {
    assert.equal((await typed(MFDataType.Floating, "3.5")).Value, 3.5);
    await rejectsWithToolError(typed(MFDataType.Floating, "abc"));
    await rejectsWithToolError(typed(MFDataType.Floating, ""));
  });

  it("validates calendar dates", async () => {
    assert.equal((await typed(MFDataType.Date, "2024-02-29")).Value, "2024-02-29");
    await rejectsWithToolError(typed(MFDataType.Date, "2023-02-29"));
    await rejectsWithToolError(typed(MFDataType.Date, "2024-5-1"));
    await rejectsWithToolError(typed(MFDataType.Date, "2024-05-01T00:00:00Z"));
  });

  it("normalizes times to HH:MM:SS", async () => {
    assert.equal((await typed(MFDataType.Time, "09:30")).Value, "09:30:00");
    assert.equal((await typed(MFDataType.Time, "23:59:59")).Value, "23:59:59");
    await rejectsWithToolError(typed(MFDataType.Time, "9:30"));
    await rejectsWithToolError(typed(MFDataType.Time, "24:00"));
  });

  it("requires a full ISO timestamp", async () => {
    assert.equal(
      (await typed(MFDataType.Timestamp, "2024-05-31T14:30:00Z")).Value,
      "2024-05-31T14:30:00Z",
    );
    await rejectsWithToolError(typed(MFDataType.Timestamp, "2024-05-31"));
  });

  it("accepts booleans and yes/no strings", async () => {
    assert.equal((await typed(MFDataType.Boolean, true)).Value, true);
    assert.equal((await typed(MFDataType.Boolean, "No")).Value, false);
    await rejectsWithToolError(typed(MFDataType.Boolean, "maybe"));
  });

  it("treats numbers as item IDs and strings as item names for lookups", async () => {
    assert.deepEqual(await typed(MFDataType.Lookup, 5, { ValueList: 300 }), {
      DataType: MFDataType.Lookup,
      HasValue: true,
      Lookup: { Item: 5, Version: -1 },
    });
    const byNameResult = await toTypedValue(
      def(MFDataType.Lookup, { ValueList: 300 }),
      "Carol",
      byName,
    );
    assert.deepEqual(byNameResult.typedValue.Lookup, { Item: 9, Version: -1 });
    assert.deepEqual(byNameResult.preview, { id: 9, name: "Carol" });
    await rejectsWithToolError(typed(MFDataType.Lookup, [1, 2], { ValueList: 300 }));
    await rejectsWithToolError(typed(MFDataType.Lookup, 0, { ValueList: 300 }));
  });

  it("can't resolve a lookup name without a value list binding", async () => {
    await rejectsWithToolError(typed(MFDataType.Lookup, "Bob"));
  });

  it("wraps a single multi-select value and de-duplicates items", async () => {
    const tv = await typed(MFDataType.MultiSelectLookup, [8, "Bob", 9], {
      ValueList: 200,
    });
    assert.deepEqual(tv.Lookups, [
      { Item: 8, Version: -1 },
      { Item: 9, Version: -1 },
    ]);
    assert.deepEqual((await typed(MFDataType.MultiSelectLookup, 8, { ValueList: 200 })).Lookups, [
      { Item: 8, Version: -1 },
    ]);
  });

  it("keeps existing multi-select items when appending", async () => {
    const { typedValue, preview } = await toTypedValue(
      def(MFDataType.MultiSelectLookup, { ValueList: 200 }),
      ["Bob"],
      byName,
      {
        append: true,
        existing: {
          DataType: MFDataType.MultiSelectLookup,
          Lookups: [
            { Item: 7, Version: 3, DisplayValue: "Alice" },
            { Item: 8, Version: 1, DisplayValue: "Bob" },
          ],
        },
      },
    );
    assert.deepEqual(typedValue.Lookups, [
      { Item: 7, Version: -1 },
      { Item: 8, Version: -1 },
    ]);
    assert.deepEqual(preview, [
      { id: 7, name: "Alice" },
      { id: 8, name: "Bob" },
    ]);
  });

  it("clears with null and with an empty multi-select array", async () => {
    assert.deepEqual(await typed(MFDataType.Text, null), emptyTypedValue(MFDataType.Text));
    assert.deepEqual(await typed(MFDataType.Lookup, null), {
      DataType: MFDataType.Lookup,
      HasValue: false,
      Lookup: null,
    });
    assert.equal((await typed(MFDataType.MultiSelectLookup, [], { ValueList: 200 })).HasValue, false);
  });

  it("rejects append on single-value properties and with null", async () => {
    await rejectsWithToolError(
      toTypedValue(def(MFDataType.Text), "x", noLookups, { append: true }),
    );
    await rejectsWithToolError(
      toTypedValue(def(MFDataType.MultiSelectLookup, { ValueList: 200 }), null, noLookups, {
        append: true,
      }),
    );
  });

  it("refuses data types it can't write", async () => {
    await rejectsWithToolError(typed(MFDataType.ACL, "x"));
    await rejectsWithToolError(typed(MFDataType.FILETIME, 1));
  });
});
