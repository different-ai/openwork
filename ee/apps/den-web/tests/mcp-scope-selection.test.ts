import { describe, expect, test } from "bun:test";

import {
  getOptionalScopeSelectionState,
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

    expect(getOptionalScopeSelectionState(selectedScopes, optionalScopes)).toBe("all");
    expect(toggleAllOptionalScopes(selectedScopes, optionalScopes)).toEqual([
      "required",
      "provider.default",
    ]);
  });

  test("reports a mixed state for partial selections", () => {
    expect(getOptionalScopeSelectionState(
      ["optional.one"],
      ["optional.one", "optional.two"],
    )).toBe("some");
  });

  test("reports an empty state when no optional scopes are selected", () => {
    expect(getOptionalScopeSelectionState(
      ["required"],
      ["optional.one", "optional.two"],
    )).toBe("none");
  });
});
