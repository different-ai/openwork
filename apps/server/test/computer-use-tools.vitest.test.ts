import { expect, test } from "vitest";
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
