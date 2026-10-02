import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineConnectorNeedsSignIn } from "../worlds/engine-connectors-parity.ts";

// Web app + a real Den per-member Notion connection the member hasn't connected yet,
// reached through OpenWork Cloud: direct calls on v1, one Code Mode `execute` on v2.
const test = spec.world(engineConnectorNeedsSignIn, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const PROMPT = "Find our roadmap page in Notion.";
const REPLY = "Notion needs you to connect it first.";
const CARD = '[data-testid="desktop-connection-card"]';

test(`AGENT-VIS-06 ${resolveEvalEngine()}: a person asks for something in a service they haven't connected and gets a Connect card`, async ({ world, user, probe, step, evidence }) => {
  await step("the person asks for their Notion roadmap page", async () => {
    await world.prepareNeedsSignIn(PROMPT, REPLY);
    await user.type("composer", PROMPT);
    await user.click("Run task");
    await user.see({ text: PROMPT });
  });

  await step("after: the chat offers to connect Notion instead of showing an error", async () => {
    await user.see({ text: REPLY }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const cards = await probe.eventually(async () => (await probe.dom(CARD)).elements, {
      within: 15_000, intervalMs: 250, label: "a connection card", until: (elements) => elements.length > 0,
    }).catch(() => []);
    const text = cards.map((card) => card.text).join(" | ");
    evidence.recordAssertionEvidence("A Connect card names the service",
      cards.length ? `card reads "${text.slice(0, 160)}"` : "no connection card in the chat", cards.length === 1 && /Notion/.test(text));
    expect(cards).toHaveLength(1);
    expect(text).toMatch(/Notion/);
    await user.see({ role: "button", label: /Connect/ });
    await user.notSee({ text: /needs_connection|connectionStatus|openwork-cloud_/ });
    await user.screenshot();
  });
});
