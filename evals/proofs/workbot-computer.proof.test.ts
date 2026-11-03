import { expect } from "vitest";
import { z } from "zod";
import { spec } from "@openwork/testkit";
import { workbotComputerWorld } from "../worlds/workbot-computer.ts";

const test = spec.world(workbotComputerWorld, { resources: { surfaces: ["web"], services: ["den"] } });

test("a member opens Workbot's Computer tab directly when the rollout is enabled", async ({ world, user, probe, step, evidence }) => {
  // Workbot locks the page while it re-checks sign-in, so it does not poll;
  // a changed rollout shows on the next load once the server reports it.
  const reloadWhenComputer = async (enabled: boolean) => {
    await probe.eventually(async () => {
      const me = await world.call("/v1/workbot/me");
      if (!me.ok) return null;
      const access = z.object({ computer: z.boolean(), browser: z.boolean(), browserLiveView: z.boolean() }).parse(await me.json());
      // The world enables only the parent browser rollout. Older-client wire compatibility follows it on and off.
      expect(access.browserLiveView).toBe(access.browser);
      return access.computer;
    }, { within: 65_000, until: value => value === enabled });
    await user.reload();
  };
  await step("before: Computer is hidden and its server refuses access while the flags are off", async () => {
    await user.see({ role: "button", label: "Home" });
    await user.notSee({ role: "button", label: "Computer" });
    const refused = await world.call("/v1/workbot/computer/viewer", { method: "POST", body: JSON.stringify({ view: "browser" }) });
    expect(refused.status).toBe(403);
    await user.screenshot();
  });
  await step("after: Computer opens with Browser and Computer views and no approval prompt", async () => {
    await world.setEnabled(true);
    await reloadWhenComputer(true);
    await user.see({ role: "button", label: "Computer" });
    await user.click({ role: "button", label: "Computer" });
    await user.see({ role: "button", label: "Browser" });
    // The tab opens on its Browser view, and the address says so.
    expect(new URL(await probe.url()).pathname).toBe("/browser");
    await user.see({ text: "Your computer is unavailable. Try reconnecting." }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Reconnect" });
    await user.notSee({ text: "Allow for this chat" });
    const visible = (await probe.dom('section[aria-label="Computer"]')).elements.length > 0;
    evidence.recordAssertionEvidence("Direct access and honest availability", "The real Workbot tab opens without consent. This fixture has no desktop provider, so it offers Reconnect instead of a fake stream.", visible);
    await user.screenshot();
  });
  await step("after: a computer that won't connect offers Rebuild, which asks before erasing it", async () => {
    await user.click({ role: "button", label: "Rebuild computer" });
    await user.see({ text: "Rebuild your computer?" });
    await user.see({ text: "Workbot replaces this computer with a fresh one. Its open apps, browser tabs and files are erased. Your chat and the files in Files are kept." });
    await user.screenshot();
    // This fixture has no desktop provider to rebuild against, so the proof stops at the confirmation.
    await user.click({ role: "button", label: "Cancel" });
    // notSee requires absence for the whole interval; first let the close transition finish.
    await probe.eventually(async () => (await probe.dom('[role="alertdialog"]')).elements.length, {
      within: 5_000, until: count => count === 0, label: "Rebuild confirmation closes after Cancel",
    });
    await user.notSee({ text: "Rebuild your computer?" });
    await user.see({ role: "button", label: "Reconnect" });
  });
  await step("the workspace navigation also opens the same Computer view", async () => {
    await user.click({ role: "button", label: "Home" });
    await world.setEnabled(true, true);
    await probe.eventually(async () => {
      const me = await world.call("/v1/workbot/me");
      return me.ok ? (await me.json() as { workspaceAssistant?: boolean }).workspaceAssistant === true : null;
    }, { within: 65_000, until: value => value === true });
    await user.reload();
    await user.see({ role: "button", label: "Open workspace navigation" });
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
    await reloadWhenComputer(false);
    await user.see({ role: "button", label: "Home" });
    await user.notSee({ role: "button", label: "Computer" });
    await user.screenshot();
  });
});
