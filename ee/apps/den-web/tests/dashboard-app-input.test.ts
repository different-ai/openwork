import { describe, expect, test } from "bun:test";
import {
  formatDashboardAppInput,
  parseDashboardAppInput,
} from "../app/(den)/dashboard/_components/dashboard-app-input";

describe("dashboard MCP App input", () => {
  test("accepts an optional JSON object and formats it for later editing", () => {
    const parsed = parseDashboardAppInput('{ "budget": 100000, "currency": "USD" }', false);
    expect(parsed).toEqual({
      ok: true,
      launchArguments: { budget: 100000, currency: "USD" },
    });
    expect(formatDashboardAppInput(parsed.ok ? parsed.launchArguments : undefined)).toBe(`{
  "budget": 100000,
  "currency": "USD"
}`);
  });

  test("leaves optional input unset when the editor is blank", () => {
    expect(parseDashboardAppInput("  ", false)).toEqual({ ok: true });
    expect(parseDashboardAppInput("{}", false)).toEqual({ ok: true });
  });

  test("requires a non-empty object when an app declares required input", () => {
    expect(parseDashboardAppInput("", true)).toEqual({
      ok: false,
      message: "This app requires tool input.",
    });
    expect(parseDashboardAppInput("{}", true)).toEqual({
      ok: false,
      message: "This app requires at least one input value.",
    });
  });

  test("rejects invalid JSON and non-object JSON without replacing saved input", () => {
    expect(parseDashboardAppInput("{", false)).toEqual({
      ok: false,
      message: "Tool input must be valid JSON.",
    });
    expect(parseDashboardAppInput("[]", false)).toEqual({
      ok: false,
      message: "Tool input must be a JSON object.",
    });
  });
});
