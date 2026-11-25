import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import type { Seed } from "@openwork/env";
import { sidebarProofWorkspace } from "../worlds/sidebar-proof-workspace.ts";

const test = spec.world(async (seed: Seed) => {
  const { app } = await sidebarProofWorkspace(seed, "composer-mention-targets");
  const chat = await seed.session(app, { title: "Draft the agenda" });
  return { app, chat };
}, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a person can still mention agents without seeing computer run targets", async ({ world, user, probe, step, evidence }) => {
  const chat = { testId: `sidebar-session-${world.chat.sessionId}` };
  const options = '[role="listbox"][aria-label="Mentions"] [role="option"]';
  await step("given an open chat", async () => {
    await user.see(chat, { timeoutMs: 45_000 });
    await user.click(chat);
    await user.see("composer");
    const selected = (await probe.hash()).includes(world.chat.sessionId);
    expect(selected).toBe(true);
    evidence.recordAssertionEvidence("The chat is ready for typing", "The composer is visible in the selected chat.", selected);
  });
  await step("when the person opens mentions", async () => {
    await user.type("composer", "@", { replace: true });
    await user.see({ role: "listbox", label: "Mentions" });
    const labels = await probe.eventually(async () => (await probe.dom(options)).elements.map(option => option.text), {
      within: 4_000, label: "an agent appears in the list", until: labels => labels.some(label => label.includes("Agent")),
    });
    const agentOptions = labels.filter(label => label.includes("Agent")).length;
    expect(agentOptions).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The menu still contains agent suggestions", `Agent options: ${agentOptions}.`, agentOptions > 0);
  });
  await step("after: the menu has no computer run targets", async () => {
    await user.see({ role: "listbox", label: "Mentions" });
    const labels = (await probe.dom(options)).elements.map(option => option.text);
    const targets = labels.filter(label => label.includes("Start a task on your"));
    evidence.recordAssertionEvidence("Agents remain available without Cloud or Desktop run targets", `Suggestions: ${labels.length}; computer run targets: ${targets.length}.`, targets.length === 0);
    await user.screenshot();
    expect(targets).toEqual([]);
  });
});
