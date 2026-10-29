import { expect, test } from "vitest";
import { z } from "zod";
import { server } from "../src/opencode-plugins/openwork-computer-use.js";

test("the agent can discover computer tools on every desktop platform, including Linux VM clients", async () => {
  const plugin = await server();
  expect(plugin.tool.computer_discover).toBeDefined();
  expect(plugin.tool.computer_open).toBeDefined();
  expect(plugin.tool.computer_act).toBeDefined();
  expect(plugin.tool.computer_run).toBeDefined();
  expect(plugin.tool.computer_close).toBeDefined();
  expect(plugin.tool.computer_discover.description).toContain("selected computer");
});

test("app scripts are offered on this Mac and approved in OpenWork, not by an engine prompt", async () => {
  const plugin = await server();
  expect(plugin.tool.computer_script).toBeDefined();
  expect(plugin.tool.computer_script.description).toContain("full script");
  expect(Object.keys(plugin.tool.computer_script.args)).toEqual(["app", "code", "timeoutMs"]);
});

test("computer tool schemas stay valid after OpenCode v1 moves $defs to definitions", async () => {
  const plugin = await server();
  for (const [name, tool] of Object.entries(plugin.tool)) {
    // Mirrors OpenCode v1's plugin conversion, which renames the root `$defs` but not the `$ref`s into it.
    const { $defs, ...schema } = z.toJSONSchema(z.object(tool.args), { io: "input" });
    expect(JSON.stringify({ ...schema, definitions: $defs }), name).not.toContain('"#/$defs/');
  }
  await expect(plugin.tool.computer_run.execute({ surface: "computer", code: "return input", input: () => 1 }, { sessionID: "s" })).rejects.toThrow();
});

test("a Windows PC is not offered app scripting", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const plugin = await server();
    expect("computer_script" in plugin.tool).toBe(false);
    expect(plugin.tool.computer_open.description).toContain("Windows PC");
  } finally { Object.defineProperty(process, "platform", platform); }
});
