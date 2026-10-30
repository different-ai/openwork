import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { activationChecklistDesktop } from "../worlds/activation-checklist.ts";

const test = spec.world(activationChecklistDesktop, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

const card = { testId: "activation-card" };
const popover = { testId: "activation-popover" };
const ANSWER_MS = 90_000;

test("an owner gets a Get set up checklist after the first answer, and a member sees who manages AI Gateway", async ({ world, user, probe, step, evidence }) => {
  const member = user.on(world.memberApp);
  const memberProbe = probe.on(world.memberApp);
  const rowState = async (id: string, state: string, on = probe) => (await on.dom(`[data-testid="activation-step-${id}"][data-state="${state}"]`)).elements.length === 1;

  await step("the checklist is available by default but has no card before the first answer", async () => {
    await user.see("composer", { editable: true });
    const den = await probe.eventually(() => world.activation("admin"), { within: 30_000, label: "Den serves the checklist", until: (value) => value.status === 200 });
    // Avery already invited Riley in this world; that fact must not reveal the card before an answer.
    expect(den.done).toEqual(["invite_teammate"]);
    await user.notSee(card);
    evidence.recordAssertionEvidence("The existing invite does not reveal the checklist before the first answer", `GET /v1/me/activation -> ${den.status}; done: ${den.done.join(", ")}; first answer not done; no card`, den.status === 200 && den.done.length === 1 && den.done[0] === "invite_teammate");
    await user.screenshot();
  });

  await step("after the first answer the sidebar card counts it, with the teammate Avery already invited: 2 of 6", async () => {
    await user.type("composer", world.owner.prompt);
    await user.press("Enter");
    await user.see({ text: world.owner.reply }, { timeoutMs: ANSWER_MS });
    await user.see({ role: "button", label: "Get set up, 2 of 6" }, { timeoutMs: 30_000 });
    await user.see({ text: "Next: Use a skill" });
    const den = await world.activation("admin");
    expect(den.done).toEqual(["first_response", "invite_teammate"]);
    evidence.recordAssertionEvidence("The first answer checks off step one; the invite Avery sent to Riley is step two", `Den done steps: ${den.done.join(", ")}; card "Get set up, 2 of 6", "Next: Use a skill"`, den.done.join() === "first_response,invite_teammate");
    await user.screenshot();
  });

  await step("opening it lists the six steps in order, each with one action", async () => {
    await user.click(card);
    await user.see(popover);
    const rows = await probe.dom('[data-testid^="activation-step-"] > div > p:first-child');
    const titles = rows.elements.map((element) => element.text.trim());
    expect(titles).toEqual(["Get your first answer", "Invite a teammate", "Use a skill", "Set up a model provider", "Share a provider on AI Gateway", "Connect an app"]);
    for (const label of ["Try a skill", "Add key", "Share", "Connect"]) await user.see({ role: "button", label });
    await user.notSee({ role: "button", label: "Invite" });
    expect(await rowState("first_response", "done")).toBe(true);
    expect(await rowState("invite_teammate", "done")).toBe(true);
    expect(await rowState("gateway_provider", "open")).toBe(true);
    await user.see({ text: "2 joined, 0 invited" });
    await user.see({ text: /^Answered in \d/ });
    evidence.recordAssertionEvidence("Six steps in recipe order; each open step has one action, done steps none", `${titles.join(" / ")}; actions Try a skill, Add key, Share, Connect; teammate row "2 joined, 0 invited"`, titles.length === 6);
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-testid="activation-popover"]'), { within: 5_000, label: "Escape closes the list", until: (dom) => dom.elements.length === 0 });
    await user.notSee(popover);
  });

  await step("a member's checklist shows AI Gateway locked with who manages it", async () => {
    await member.see("composer", { editable: true });
    await member.notSee(card);
    await member.type("composer", world.member.prompt);
    await member.press("Enter");
    await member.see({ text: world.member.reply }, { timeoutMs: ANSWER_MS });
    await member.see({ role: "button", label: "Get set up, 2 of 6" }, { timeoutMs: 30_000 });
    await member.click(card);
    await member.see(popover);
    await member.see({ text: "Avery Owner manages AI Gateway" });
    const locked = await rowState("gateway_provider", "locked", memberProbe);
    const invited = await rowState("invite_teammate", "done", memberProbe);
    expect(locked).toBe(true);
    expect(invited).toBe(true);
    await member.notSee({ role: "button", label: "Share" });
    evidence.recordAssertionEvidence("Locked, not hidden, and names the owner", `gateway row locked=${locked}; teammate row done=${invited}; "Avery Owner manages AI Gateway"; no Share action`, locked && invited);
    await member.screenshot();
    await member.press("Escape");
  });

  await step("after the owner shares a provider on AI Gateway, the step checks off for both", async () => {
    const shared = await world.shareGatewayProvider();
    await user.reload();
    await user.see({ role: "button", label: "Get set up, 3 of 6" }, { timeoutMs: 30_000 });
    await user.click(card);
    await user.see(popover);
    await user.see({ text: "Team OpenAI on AI Gateway" });
    expect(await rowState("gateway_provider", "done")).toBe(true);
    await member.reload();
    await member.see({ role: "button", label: "Get set up, 3 of 6" }, { timeoutMs: 30_000 });
    const [ownerDen, memberDen] = await Promise.all([world.activation("admin"), world.activation("riley")]);
    expect(ownerDen.done).toContain("gateway_provider");
    expect(memberDen.done).toContain("gateway_provider");
    evidence.recordAssertionEvidence("Shared on AI Gateway counts for the whole team", `POST /v1/inference-providers -> ${shared.status}; owner done: ${ownerDen.done.join(", ")}; member done: ${memberDen.done.join(", ")}`, ownerDen.done.includes("gateway_provider") && memberDen.done.includes("gateway_provider"));
    await user.screenshot();
  });
});
