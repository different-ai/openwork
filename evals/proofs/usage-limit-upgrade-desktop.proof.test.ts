import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { usageLimitUpgradeDesktop } from "../worlds/usage-limit-upgrade-desktop.ts";

// Real app, engine and gateway (its own disposable database) with a fake OpenRouter upstream; Den holds roles.
const test = spec.world(usageLimitUpgradeDesktop, {
  timeout: 900_000,
  needs: { placement: "local" },
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

async function send(user: User, probe: Probe, text: string) {
  await user.see("composer", { editable: true, timeoutMs: 60_000 });
  await user.type("composer", text);
  await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
    within: 30_000, label: "the conversation is ready to send", until: (value) => value.elements.length === 1,
  });
  await user.click("Run task");
}

test("an owner whose workspace used its OpenWork Models allowance sees when it resets and how to keep going", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  const cards = () => probe.dom('[data-testid="usage-limit-card"]');

  await step("the owner's card says what ran out, when it resets and that the message is saved, with a team-provider action", async () => {
    const before = await world.gatewayRequests();
    await send(user, probe, "Draft the Q4 hiring plan from these notes.");
    const shown = await probe.eventually(cards, { within: 90_000, label: "the refused message shows the usage-limit card", until: (value) => value.elements.length === 1 });
    const latest = shown.elements.at(-1)?.text ?? "";
    expect(latest).toContain("Acme used its OpenWork Models allowance");
    expect(latest).toMatch(/5-hour allowance resets in (1 hour|\d+ minutes)/);
    expect(latest).toContain("Your message is saved");
    expect(latest).toContain("Add a team provider");
    expect(latest).toContain("Use another model");
    expect(latest).not.toMatch(/Ask an admin|org_/);
    await user.notSee({ text: "This model is receiving too many requests" });
    await user.notSee({ text: /Retrying/ });
    const sent = await world.gatewayRequests() - before;
    evidence.recordAssertionEvidence("An owner gets the classified card with its reset and a paid way forward, from one refused request", `card="${latest.replace(/\s+/g, " ").slice(0, 160)}"; gateway requests=${sent}`, sent === 1);
    expect(sent).toBe(1);
    await user.screenshot();
  });

  await step("Use another model opens the model picker so the owner can keep working", async () => {
    await user.click({ role: "button", label: "Use another model" });
    await user.see({ testId: "composer-model-picker" });
    const picker = await probe.dom('[data-testid="composer-model-picker"]');
    const open = picker.elements.length === 1 && picker.elements[0]?.text.includes(world.modelName) === true;
    evidence.recordAssertionEvidence("The card's way to keep working opens the composer's model picker", `model pickers open=${picker.elements.length}; lists ${world.modelName}=${open}`, open);
    expect(open).toBe(true);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("a member sees who can buy more, never a purchase or provider action", async () => {
    const member = user.on(world.memberApp);
    const memberProbe = probe.on(world.memberApp);
    await member.resizeViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
    await member.reload();
    await send(member, memberProbe, "Summarize this contract.");
    await member.see({ testId: "usage-limit-card" }, { timeoutMs: 90_000 });
    await member.see({ text: "Acme used its OpenWork Models allowance" });
    await member.see({ role: "button", label: /^Ask an admin for more/ });
    await member.notSee({ role: "button", label: "Add a team provider" });
    await member.notSee({ role: "button", label: "Upgrade plan" });
    const locked = await memberProbe.dom('[data-testid="usage-limit-locked"]:is([aria-disabled="true"], :disabled)');
    const buy = await memberProbe.dom('[data-testid="usage-limit-card"] [data-action="add_team_provider"], [data-testid="usage-limit-card"] [data-action="upgrade_plan"], [data-testid="usage-limit-card"] [data-action="get_models"]');
    evidence.recordAssertionEvidence("A member's card keeps the action visible but locked, with no buy or provider button", `locked actions=${locked.elements.length}; buy actions=${buy.elements.length}`, locked.elements.length === 1 && buy.elements.length === 0);
    expect(locked.elements).toHaveLength(1);
    expect(buy.elements).toHaveLength(0);
    await member.screenshot();
  });
});
