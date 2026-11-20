import { describe, expect, test } from "vitest";
import { server } from "../src/opencode-plugins/openwork-chrome-devtools.js";

const plugin = await server();
const action = plugin.tool.browser_act.args.action;

describe("secret handles in the browser tool contract", () => {

  test("accepts only an observed field and an opaque handle", () => {
    const input = { type: "fill_secret", ref: "e1", secretRef: "sec_fixture_handle" };
    expect(action.parse(input)).toEqual(input);
  });

  test("rejects a literal value instead of silently dropping it", () => {
    expect(action.safeParse({ type: "fill_secret", ref: "e1", secretRef: "sec_fixture_handle", text: "fixture-only-value" }).success).toBe(false);
  });

  test("ordinary fill treats a handle as literal text", () => {
    const input = { type: "fill", ref: "e1", text: "sec_fixture_handle" };
    expect(action.parse(input)).toEqual(input);
  });
});
