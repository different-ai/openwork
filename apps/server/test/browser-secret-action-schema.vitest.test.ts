import { describe, expect, test } from "vitest";
import { z } from "zod";
import { server } from "../src/opencode-plugins/openwork-chrome-devtools.js";
import { usePrivateValuesArgs } from "../src/opencode-plugins/private-values-tool.js";

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

describe("fields filled from a command in the browser tool contract", () => {
  const command = ["op", "read", "op://Private/Example/password"];

  test("accepts only an observed field and a program with its arguments", () => {
    const input = { type: "fill_from", ref: "e1", command };
    expect(action.parse(input)).toEqual(input);
  });

  test("rejects a literal value, a handle, an environment or a command given as one line", () => {
    for (const extra of [{ text: "fixture-only-value" }, { secretRef: "sec_fixture_handle" }, { env: { FIXTURE: "x" } }]) {
      expect(action.safeParse({ type: "fill_from", ref: "e1", command, ...extra }).success).toBe(false);
    }
    expect(action.safeParse({ type: "fill_from", ref: "e1", command: command.join(" ") }).success).toBe(false);
    expect(action.safeParse({ type: "fill_from", ref: "e1", command: [] }).success).toBe(false);
  });

  test("accepts a command with the one variable it reads a pasted key from", () => {
    const input = { type: "fill_from", ref: "e1", command: ["bw", "get", "password", "example.com"], unlock: { env: "BW_SESSION", ask: "Bitwarden session key" } };
    expect(action.parse(input)).toEqual(input);
  });

  test("rejects an unlock that carries a value, lacks its name, or is not an object", () => {
    for (const unlock of [{ env: "BW_SESSION" }, { ask: "Bitwarden session key" }, { env: "BW_SESSION", ask: "Key", value: "fixture-only-value" }, { env: "", ask: "Key" }, "BW_SESSION", [{ env: "BW_SESSION", ask: "Key" }]]) {
      expect(action.safeParse({ type: "fill_from", ref: "e1", command, unlock }).success).toBe(false);
    }
  });

  test("accepts an observed field and a name the person pastes the value under", () => {
    const input = { type: "fill_from", ref: "e1", ask: "Example password" };
    expect(action.parse(input)).toEqual(input);
  });

  test("rejects a name that is empty, too long or not text, and a value beside it", () => {
    for (const ask of ["", "x".repeat(81), 7, ["Example password"]]) {
      expect(action.safeParse({ type: "fill_from", ref: "e1", ask }).success).toBe(false);
    }
    for (const extra of [{ text: "fixture-only-value" }, { value: "fixture-only-value" }, { kept: true }]) {
      expect(action.safeParse({ type: "fill_from", ref: "e1", ask: "Example password", ...extra }).success).toBe(false);
    }
  });
});

describe("private values given to a program or a request in the tool contract", () => {
  const schema = z.object(usePrivateValuesArgs);
  const token = { name: "DEPLOY_TOKEN", command: ["op", "read", "op://Private/Deploy/token"] };

  test("accepts named values from a command or a paste, for one program or one request", () => {
    expect(schema.parse({ values: [token], run: { command: ["deploy"] } })).toEqual({ values: [token], run: { command: ["deploy"] } });
    const request = { method: "POST", url: "https://api.example/v1/deploy", headers: { Authorization: "Bearer {{DEPLOY_TOKEN}}" } };
    expect(schema.parse({ values: [{ name: "DEPLOY_TOKEN", ask: "Deploy token" }], request })).toEqual({ values: [{ name: "DEPLOY_TOKEN", ask: "Deploy token" }], request });
  });

  test("rejects a literal value or a lowercase name, and never takes a working folder from the agent", () => {
    for (const value of [{ ...token, value: "fixture-only-value" }, { ...token, text: "fixture-only-value" }, { ...token, name: "deploy_token" }, { ...token, as: "stdin" }]) {
      expect(schema.safeParse({ values: [value], run: { command: ["deploy"] } }).success).toBe(false);
    }
    expect(schema.safeParse({ values: Array.from({ length: 7 }, (_, index) => ({ ...token, name: `T${index}` })), run: { command: ["x"] } }).success).toBe(false);
    expect(schema.parse({ values: [token], run: { command: ["deploy"] }, cwd: "/" })).not.toHaveProperty("cwd");
  });

  test("is not one of the browser's tools", () => {
    expect(Object.keys(plugin.tool)).not.toContain("use_private_values");
  });
});
