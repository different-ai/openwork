import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotComputerWorld } from "../worlds/workbot-computer.ts";

const test = spec.world(workbotComputerWorld, { resources: { surfaces: ["web"], services: ["den"] } });

test("a member opens Workbot's Computer tab directly when the rollout is enabled", async ({ world, user, probe, step, evidence }) => {
  await step("before: Computer is hidden and its server refuses access while the flags are off", async () => {
    await user.see({ role: "button", label: "Home" });
    await user.notSee({ role: "button", label: "Computer" });
    const refused = await world.call("/v1/workbot/computer/viewer", { method: "POST", body: JSON.stringify({ view: "browser" }) });
    expect(refused.status).toBe(403);
    await user.screenshot();
  });
  await step("after: Computer opens with Browser and Computer views and no approval prompt", async () => {
    await world.setEnabled(true);
    await user.see({ role: "button", label: "Computer" }, { timeoutMs: 65_000 });
    await user.click({ role: "button", label: "Computer" });
    await user.see({ role: "button", label: "Browser" });
    await user.see({ text: "Your computer is unavailable. Try reconnecting." }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Reconnect" });
    await user.notSee({ text: "Allow for this chat" });
    const visible = (await probe.dom('section[aria-label="Computer"]')).elements.length > 0;
    evidence.recordAssertionEvidence("Direct access and honest availability", "The real Workbot tab opens without consent. This fixture has no desktop provider, so it offers Reconnect instead of a fake stream.", visible);
    await user.screenshot();
  });
  await step("the workspace navigation also opens the same Computer view", async () => {
    await user.click({ role: "button", label: "Home" });
    await world.setEnabled(true, true);
    await user.see({ role: "button", label: "Open workspace navigation" }, { timeoutMs: 65_000 });
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.click({ role: "button", label: "Computer" });
    await user.see({ role: "button", label: "Browser" });
    await user.see({ text: "Your computer is unavailable. Try reconnecting." }, { timeoutMs: 30_000 });
    await user.notSee({ text: "Allow for this chat" });
    await user.screenshot();
  });
  await step("turning the flags off closes Computer and rejects new viewer connections", async () => {
    await world.setEnabled(false);
    await probe.eventually(async () => (await world.call("/v1/workbot/computer/viewer", { method: "POST", body: JSON.stringify({ view: "computer" }) })).status, { within: 65_000, until: value => value === 403 });
    // The API cache and the page refresh independently. Home returns in the
    // classic navigation once the page has observed the revoked rollouts.
    await user.see({ role: "button", label: "Home" }, { timeoutMs: 65_000 });
    await user.notSee({ role: "button", label: "Computer" });
    await user.screenshot();
  });
});
