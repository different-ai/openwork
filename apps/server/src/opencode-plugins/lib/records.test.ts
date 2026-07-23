import { describe, expect, test } from "bun:test";

import {
  getRecordProperty,
  isRecord,
  optionalStringProperty,
  readNestedString,
  readString,
} from "./records.js";

describe("record helpers", () => {
  test("recognizes non-null, non-array objects as records", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("record")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });

  test("reads and trims non-empty strings", () => {
    expect(readString("  value  ")).toBe("value");
    expect(readString(" \n\t ")).toBeUndefined();
    expect(readString(42)).toBeUndefined();
  });

  test("reads a property only from records", () => {
    expect(getRecordProperty({ value: 42 }, "value")).toBe(42);
    expect(getRecordProperty({ value: undefined }, "value")).toBeUndefined();
    expect(getRecordProperty(["value"], "0")).toBeUndefined();
    expect(getRecordProperty(null, "value")).toBeUndefined();
  });

  test("reads and trims a nested string", () => {
    expect(readNestedString({ outer: { inner: "  value  " } }, ["outer", "inner"])).toBe("value");
    expect(readNestedString({ outer: { inner: "   " } }, ["outer", "inner"])).toBeUndefined();
    expect(readNestedString({ outer: null }, ["outer", "inner"])).toBeUndefined();
    expect(readNestedString({ outer: { other: "value" } }, ["outer", "inner"])).toBeUndefined();
  });

  test("reads a non-empty string property without changing its whitespace", () => {
    expect(optionalStringProperty({ value: "  value  " }, "value")).toBe("  value  ");
    expect(optionalStringProperty({ value: "   " }, "value")).toBeUndefined();
    expect(optionalStringProperty({ value: 42 }, "value")).toBeUndefined();
    expect(optionalStringProperty([], "value")).toBeUndefined();
  });
});
