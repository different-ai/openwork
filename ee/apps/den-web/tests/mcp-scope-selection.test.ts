import { describe, expect, test } from "bun:test";

import {
  areAllOptionalScopesSelected,
  OPTIONAL_SCOPE_BULK_TOGGLE_THRESHOLD,
  toggleAllOptionalScopes,
} from "../app/(den)/dashboard/_components/mcp-scope-selection";

describe("MCP optional scope selection", () => {
  test("shows the bulk control only beyond five optional scopes", () => {
    expect(OPTIONAL_SCOPE_BULK_TOGGLE_THRESHOLD).toBe(5);
  });

  test("selects every optional scope without duplicating or removing required scopes", () => {
    expect(toggleAllOptionalScopes(
      ["required", "optional.one"],
      ["optional.one", "optional.two", "optional.three"],
    )).toEqual(["required", "optional.one", "optional.two", "optional.three"]);
  });

  test("clears optional scopes while preserving required and unrelated scopes", () => {
    const optionalScopes = ["optional.one", "optional.two"];
    const selectedScopes = ["required", "optional.one", "optional.two", "provider.default"];

    expect(areAllOptionalScopesSelected(selectedScopes, optionalScopes)).toBe(true);
    expect(toggleAllOptionalScopes(selectedScopes, optionalScopes)).toEqual([
      "required",
      "provider.default",
    ]);
  });

  test("treats a partial selection as not all selected", () => {
    expect(areAllOptionalScopesSelected(
      ["optional.one"],
      ["optional.one", "optional.two"],
    )).toBe(false);
  });
});
