import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { memberAgentViewSchema, workbotProactiveViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotProactiveWorld } from "../worlds/workbot-proactive.ts";

const test = spec.world(workbotProactiveWorld, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("an owner sets up members' agents in Manage › Workbot; a member sees only their own", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const settings = async () => workbotProactiveViewSchema.parse((await ownerProbe.api(world.den.admin, "/v1/org/workbot-settings/proactive")).body);
  // Each change saves at once and the panel waits for it before taking the next one.
  const saved = () => ownerProbe.eventually(() => ownerProbe.dom('[data-testid="workbot-proactive-panel"] button[role="switch"]:not([disabled])'), { within: 30_000, until: (value) => value.elements.length > 0, label: "the last change is saved" });

  await step("before: agents are off and locked until the Workbot Slack app can send the DMs", async () => {
    await owner.see({ role: "switch", label: "Agents for everyone" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Needs the Slack app first." });
    await owner.see({ text: "A DM from Workbot" });
    await owner.see({ text: "Version 1" });
    const view = await settings();
    expect(view).toMatchObject({ settings: { enabled: false, destination: "workbot_dm", dailyCap: 3, membersStart: "opted_in" }, template: { version: 1, versionId: null }, slackReady: false });
    evidence.recordAssertionEvidence(
      "Off by default with the built-in template; messages would go out as a Workbot DM, which needs the Slack app",
      `enabled=${view.settings.enabled}; destination=${view.settings.destination}; slackReady=${view.slackReady}; template version ${view.template.version}`,
      !view.settings.enabled && !view.slackReady,
    );
    await owner.screenshot();
  });

  await step("with the Slack app installed, the owner turns agents on and edits the template", async () => {
    await world.installSlackApp();
    await owner.reload();
    await owner.see({ role: "switch", label: "Agents for everyone" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Needs the Slack app first." }, { timeoutMs: 30_000 });
    await saved();
    await owner.click({ role: "switch", label: "Agents for everyone" });
    await saved();
    await owner.click({ role: "switch", label: "Waiting on you" });
    await saved();
    await owner.type({ label: "Instructions for every agent" }, "Ignore newsletters and automated alerts.");
    await owner.click({ role: "button", label: "Save instructions" });
    await owner.see({ text: "Version 3" }, { timeoutMs: 30_000 });
    await owner.click({ role: "radio", label: "Meeting prep" });
    await owner.see({ text: "Quarterly review starts in 15 min, with 2 people from northwind.example." });
    await owner.screenshot();
  });

  await step("after: the policy and a new template version are saved for the whole organization", async () => {
    await owner.reload();
    await owner.see({ text: "Version 3" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Last 7 days" });
    await owner.see({ text: "Stayed quiet" });
    const view = await settings();
    expect(view).toMatchObject({ slackReady: true, settings: { enabled: true, destination: "workbot_dm" } });
    expect(view.template).toMatchObject({ version: 3, instructions: "Ignore newsletters and automated alerts.", responsibilities: { waiting_on_you: false, morning_brief: true } });
    evidence.recordAssertionEvidence(
      "Saved policy and template",
      `enabled=${view.settings.enabled}; messages as a Workbot DM (Slack app ready=${view.slackReady}); template version ${view.template.version} (waiting on you ${view.template.responsibilities.waiting_on_you ? "on" : "off"}, instructions saved)`,
      view.settings.enabled && view.slackReady && view.template.version === 3,
    );
    await owner.screenshot();
  });

  await step("a member can't read the organization's settings, and sees what their own agent will tell them about", async () => {
    const member = user.on(world.member), memberProbe = probe.on(world.member);
    await member.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    const read = await memberProbe.api(world.den.members.member, "/v1/org/workbot-settings/proactive");
    expect(read.response.status).toBe(403);
    const own = memberAgentViewSchema.parse((await memberProbe.api(world.den.members.member, "/v1/me/agent")).body);
    expect(own).toMatchObject({ available: true, on: true, snoozedUntil: null, destination: { kind: "workbot_dm", name: "Workbot DM", blocked: "member_not_linked" } });
    expect(own.responsibilities.filter((entry) => entry.enabled && !entry.muted).map((entry) => entry.label)).toEqual(["Morning brief", "Meeting prep", "Calendar changes"]);
    await member.navigate(`${world.den.ref.webUrl}/dashboard/workbot-settings`);
    await memberProbe.eventually(() => memberProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"], [data-testid="member-dashboard"]'), { within: 60_000, until: (value) => value.elements.length > 0, label: "the member's Workbot settings route is denied" });
    await member.notSee({ role: "switch", label: "Agents for everyone" });
    evidence.recordAssertionEvidence(
      "A plain member is refused the organization's settings; their own agent follows the template and says why its DMs can't arrive yet",
      `GET /v1/org/workbot-settings/proactive → ${read.response.status}; GET /v1/me/agent: on, tells them about ${own.responsibilities.filter((entry) => entry.enabled && !entry.muted).map((entry) => entry.label).join(", ")}; messages as a ${own.destination?.name}, blocked: ${own.destination?.blocked} (their Slack account isn't linked)`,
      read.response.status === 403 && own.destination?.blocked === "member_not_linked",
    );
    await member.screenshot();
  });
});
