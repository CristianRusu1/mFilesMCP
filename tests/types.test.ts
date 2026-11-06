import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDataTypeName, DataType, MFDataType } from "../src/types.js";

describe("resolveDataTypeName", () => {
  it("maps the canonical MFDataType integers", () => {
    assert.equal(resolveDataTypeName(1), "Text");
    assert.equal(resolveDataTypeName(2), "Integer");
    assert.equal(resolveDataTypeName(3), "Floating");
    assert.equal(resolveDataTypeName(5), "Date");
    assert.equal(resolveDataTypeName(6), "Time");
    assert.equal(resolveDataTypeName(7), "Timestamp");
    assert.equal(resolveDataTypeName(8), "Boolean");
    assert.equal(resolveDataTypeName(9), "SingleSelectLookup");
    assert.equal(resolveDataTypeName(10), "MultiSelectLookup");
    assert.equal(resolveDataTypeName(11), "Integer64");
    assert.equal(resolveDataTypeName(12), "FILETIME");
    assert.equal(resolveDataTypeName(13), "MultiLineText");
    assert.equal(resolveDataTypeName(14), "ACL");
  });

  it("returns an Unknown(n) label for unrecognized values", () => {
    assert.equal(resolveDataTypeName(999), "Unknown(999)");
  });

  it("matches the data types of built-in properties seen on a live vault", () => {
    // Regression guard: an earlier mapping labelled these wrongly. Built-in
    // property IDs are fixed by M-Files, so their types are a reliable check:
    // Single file (22) = 8, Class (100) = 9, Assigned to (44) = 10,
    // Comment (33) = 13.
    assert.equal(DataType[8], "Boolean");
    assert.equal(DataType[9], "SingleSelectLookup");
    assert.equal(DataType[10], "MultiSelectLookup");
    assert.equal(DataType[13], "MultiLineText");
  });

  it("keeps the label table and the MFDataType constants in sync", () => {
    for (const value of Object.values(MFDataType)) {
      assert.ok(DataType[value], `no label for MFDataType ${value}`);
    }
  });
});
