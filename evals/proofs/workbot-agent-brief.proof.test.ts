import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { DEFAULT_AGENT_BRIEF, memberAgentViewSchema, workbotProactiveViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotAgentBriefWorld } from "../worlds/workbot-agent-brief.ts";

const test = spec.world(workbotAgentBriefWorld, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

// Your agent's brief (workbotAgentBrief). DESIGN P1 (state, not explanation), P2 (title or description), P3 (the
// organization's brief behind a disclosure), P8 (Undo, no confirm), S2 (compact rows), C1/C7 (plain, sentence case).
test("an admin sets one rhythm and a brief; a member adds lines from chat and sees their next checks", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const settings = async () => workbotProactiveViewSchema.parse((await ownerProbe.api(world.den.admin, "/v1/org/workbot-settings/proactive")).body);
  const agent = async () => memberAgentViewSchema.parse((await probe.api(world.den.members.member, "/v1/me/agent")).body);
  const saved = () => ownerProbe.eventually(() => ownerProbe.dom('[data-testid="workbot-proactive-panel"] button[role="switch"]:not([disabled])'), { within: 30_000, until: (value) => value.elements.length > 0, label: "the last change is saved" });

  await step("before: with the brief off, Manage › Workbot shows today's four message types and instructions", async () => {
    await owner.see({ role: "switch", label: "Agents for everyone" }, { timeoutMs: 90_000 });
    await owner.see({ role: "switch", label: "Waiting on you" });
    await owner.see({ role: "switch", label: "Meeting prep" });
    await owner.see({ text: "Instructions for every agent" });
    const view = await settings();
    evidence.recordAssertionEvidence("Off: today's settings, no brief in the API", `brief=${view.brief === undefined ? "absent" : "present"}; meeting prep ${view.template.responsibilities.meeting_prep ? "on" : "off"}`, view.brief === undefined);
    expect(view.brief).toBeUndefined();
    await owner.screenshot();
  });

  await step("on: one rhythm, messages per day, extra checks and what to tell people, carried over from the earlier settings", async () => {
    await world.setBrief(true);
    await owner.reload();
    await owner.see({ text: "What to tell people" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Every 2 hours" });
    await owner.see({ text: "Messages per person per day" });
    await owner.see({ text: "Extra checks agents may ask for" });
    await owner.see({ text: "From your earlier settings." });
    await owner.notSee({ role: "switch", label: "Waiting on you" });
    await owner.notSee({ text: "Instructions for every agent" });
    const view = await settings();
    evidence.recordAssertionEvidence(
      "The brief carries meeting prep off and the organization's instruction over; the old default limit becomes 4",
      `every ${view.brief?.checkEveryHours}h, ${view.brief?.dailyCap} a day, ${view.brief?.extraChecksPerDay} extra checks; text ends: ${JSON.stringify(view.brief?.text.slice(-60))}; carried over: ${view.brief?.carriedOver.join(", ")}`,
      view.brief?.text === `${DEFAULT_AGENT_BRIEF}\n\nDon't send meeting prep.\n\nIgnore build bot alerts.` && view.brief.dailyCap === 4,
    );
    expect(view.brief?.text.endsWith("Don't send meeting prep.\n\nIgnore build bot alerts.")).toBe(true);
    await owner.screenshot();
  });

  await step("the admin saves the brief with one more line; it is saved for every agent", async () => {
    await saved();
    await owner.type({ label: "What to tell people" }, `${DEFAULT_AGENT_BRIEF}\n\nDon't send meeting prep.\nAlso flag anything about the Q4 launch.`);
    await owner.click({ role: "button", label: "Save brief" });
    await owner.notSee({ text: "From your earlier settings." }, { timeoutMs: 30_000 });
    await owner.see({ role: "button", label: "Reset to default" });
    const view = await settings();
    evidence.recordAssertionEvidence("Saved brief", `carried over now: ${view.brief?.carriedOver.join(", ") || "none"}; ends with ${JSON.stringify(view.brief?.text.slice(-40))}`, view.brief?.carriedOver.includes("text") === false);
    expect(view.brief?.text.endsWith("Also flag anything about the Q4 launch.")).toBe(true);
    await owner.screenshot();
  });

  await step("a member says \"also watch our Render bill, never tell me about newsletters\" in chat; My bot shows it, with the next checks", async () => {
    const said = await world.sayInChat("putMeAgent", { brief: { add: ["Also watch our Render bill.", "Never tell me about newsletters."] } });
    expect(said.ok).toBe(true);
    await user.reload();
    await user.see({ testId: "my-agent-brief" }, { timeoutMs: 60_000 });
    await user.see({ text: new RegExp(`^Next check \\d{1,2}:\\d{2} PM: ${world.why}\\. Then \\d{1,2}:\\d{2} PM\\.$`) });
    await user.see({ text: new RegExp("^Saved from chat at ") });
    await user.see({ text: "Your organization's brief" });
    await user.notSee({ text: "What it tells you about" });
    const view = await agent();
    evidence.recordAssertionEvidence(
      "Chat saved the member's lines; My bot shows them with where they came from and the extra check the agent asked for, with why",
      `lines: ${JSON.stringify(view.brief?.lines)}; next: ${view.nextChecks?.map((check) => `${check.kind}${check.why ? ` (${check.why})` : ""}`).join(", ")}; checks every ${view.limits?.checkEveryHours}h`,
      view.brief?.lines === "Also watch our Render bill.\nNever tell me about newsletters." && view.nextChecks?.[0]?.kind === "requested",
    );
    expect(view.nextChecks?.[0]?.at).toBe(new Date(Math.floor(world.requested / 1000) * 1000).toISOString());
    await user.screenshot();
  });

  await step("\"check every hour\" is refused in chat (the admin checks every 2 hours); \"every 3 hours\" is saved", async () => {
    const faster = await world.sayInChat("putMeAgent", { checkEveryHours: 1 });
    const slower = await world.sayInChat("putMeAgent", { checkEveryHours: 3 });
    const view = await agent();
    evidence.recordAssertionEvidence("The server enforces the admin's rhythm", `every hour → refused=${!faster.ok}; every 3 hours → ${view.limits?.checkEveryHours}h`, !faster.ok && slower.ok && view.limits?.checkEveryHours === 3);
    expect(faster.ok).toBe(false);
    expect(view.limits?.checkEveryHours).toBe(3);
  });
});
