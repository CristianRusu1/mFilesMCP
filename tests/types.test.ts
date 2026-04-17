import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDataTypeName, DataType } from "../src/types.js";

describe("resolveDataTypeName", () => {
  it("maps the canonical MFDataType integers", () => {
    assert.equal(resolveDataTypeName(1), "Text");
    assert.equal(resolveDataTypeName(2), "Integer");
    assert.equal(resolveDataTypeName(3), "Floating");
    assert.equal(resolveDataTypeName(5), "Date");
    assert.equal(resolveDataTypeName(6), "Time");
    assert.equal(resolveDataTypeName(7), "Timestamp");
    assert.equal(resolveDataTypeName(8), "SingleSelectLookup");
    assert.equal(resolveDataTypeName(9), "MultiSelectLookup");
    assert.equal(resolveDataTypeName(10), "MultiLineText");
    assert.equal(resolveDataTypeName(11), "Boolean");
    assert.equal(resolveDataTypeName(12), "FileReference");
    assert.equal(resolveDataTypeName(13), "Integer64");
  });

  it("returns an Unknown(n) label for unrecognized values", () => {
    assert.equal(resolveDataTypeName(999), "Unknown(999)");
  });

  it("includes Boolean at 11, not 7 (plan.md draft had this swapped)", () => {
    // Regression guard: we fixed this after seeing real data come back where
    // Timestamp properties had DataType=7, contradicting the draft enum.
    assert.notEqual(DataType[7], "Boolean");
    assert.equal(DataType[11], "Boolean");
  });
});
