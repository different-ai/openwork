import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { OpenWorkCapabilitiesKnowledge } from "../../apps/server/src/opencode-plugins/openwork-capabilities-knowledge";

test("OpenWork system-prompt hooks keep the engine request at one system message", async ({ evidence }) => {
  // Claim: OpenCode sends each `system` entry as its own `role: "system"`
  // message, and several chat templates behind OpenAI-compatible endpoints
  // reject any system message after the first. Both OpenWork transform hooks,
  // run in the order the runtime config registers them, must therefore extend
  // the engine's single entry rather than push new ones.
  const engineMcp = {
    async status() {
      return { data: { "openwork-cloud": { status: "connected" } } };
    },
  };
  const extensions = await OpenWorkExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await OpenWorkCapabilitiesKnowledge();
  const output: { system: string[] } = { system: ["engine header"] };

  await extensions["experimental.chat.system.transform"]({}, output);
  await knowledge["experimental.chat.system.transform"]({}, output);

  expect(output.system).toHaveLength(1);
  expect(output.system[0].startsWith("engine header\n")).toBe(true);
  // Nothing was dropped to get there: both contributions are still present,
  // in registration order, after the engine header.
  const routing = output.system[0].indexOf("verified ready for this exact workspace/model");
  const browser = output.system[0].indexOf("## Built-in Browser (external websites)");
  const capabilities = output.system[0].indexOf("You are running inside OpenWork.");
  expect(routing).toBeGreaterThan("engine header".length);
  expect(browser).toBeGreaterThan(routing);
  expect(capabilities).toBeGreaterThan(browser);

  // Negative half: when the engine hands over an empty array the hooks still
  // produce exactly one entry, never a leading empty message.
  const empty: { system: string[] } = { system: [] };
  await extensions["experimental.chat.system.transform"]({}, empty);
  await knowledge["experimental.chat.system.transform"]({}, empty);
  expect(empty.system).toHaveLength(1);
  expect(empty.system[0].startsWith("\n")).toBe(false);

  evidence.recordAssertionEvidence(
    "OpenWork instructions fold into a single system message",
    "Running the extensions-preview and capabilities-knowledge transform hooks in registration order leaves the engine system array at length 1, with the engine header first and every OpenWork section retained in order; an empty engine array also yields exactly one non-empty entry.",
    true,
  );
});
