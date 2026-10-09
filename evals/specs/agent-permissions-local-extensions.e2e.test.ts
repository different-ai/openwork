import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { randomUUID } from "node:crypto";
import { agentPermissionsDesktop, folderSkills } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsDesktop, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Local skills and the built-in browser follow a member's agent permissions only in the desktop app, whose local OpenWork server and Electron browser receive them with the member's Den session.",
  },
  needs: { placement: "local" },
});

test("a contractor's agent loads only the local skills the team allows, and the built-in browser opens only the sites it allows", async ({ world, user, agent, step, evidence }) => {
  /** The witness model loads `name` the way each engine's skill tool takes it: by name on v1, from the offered catalog on v2. */
  const loadSkill = (name: string): MockAgentToolStep[] => world.engine === "v2"
    ? [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: name } }]
    : [{ tool: "skill", arguments: { name } }];
  const isSkill = (name: string) => (input: Record<string, unknown>) => input.name === name || input.id === name;
  const send = async (prompt: string) => {
    await user.type("composer", prompt);
    await user.click("Run task");
  };

  await step("given Riley's folder has the team's checklist skill and a notes skill the team does not allow", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const rules = await world.enforcedRules();
    const skillRules = rules.filter((rule) => rule.action === "skill").map((rule) => `${String(rule.resource)} → ${String(rule.effect)}`);
    evidence.recordAssertionEvidence(`skill rules Riley's OpenWork enforces (${world.engine})`, skillRules.join("; "), skillRules.join("; ") === "* → deny; team-* → allow");
    expect(skillRules).toEqual(["* → deny", "team-* → allow"]);
    await user.screenshot();
  });

  await step("the agent loads the team's checklist skill, which Contractors allow", async () => {
    const prompt = `Follow the team checklist. ${randomUUID()}`;
    await world.prepareTurn(prompt, `Checklist loaded. ${randomUUID()}`, loadSkill(folderSkills.allowed.name), "last-tool-text");
    await send(prompt);
    await user.see({ text: new RegExp(folderSkills.allowed.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }, { timeoutMs: 120_000 });
    const call = await world.toolCall("skill", isSkill(folderSkills.allowed.name));
    evidence.recordAssertionEvidence("the team-checklist skill", `${call?.status ?? "none"}; its steps reached the agent`, call?.status === "completed");
    expect(call?.status).toBe("completed");
    await user.screenshot();
  });

  await step("the folder's notes skill never reaches the agent", async () => {
    const prompt = `Use the notes helper. ${randomUUID()}`;
    const reply = `Notes helper unavailable. ${randomUUID()}`;
    await world.prepareTurn(prompt, reply, loadSkill(folderSkills.blocked.name));
    await send(prompt);
    await user.see({ text: reply }, { timeoutMs: 120_000 });
    await user.notSee({ text: folderSkills.blocked.marker });
    const call = await world.toolCall("skill", isSkill(folderSkills.blocked.name));
    const reason = `${call?.error ?? ""} ${call?.output ?? ""}`.trim();
    // v1 offers the skill tool and blocks the call; v2 leaves the skill out of the catalog it offers.
    const kept = call === null
      ? (await world.mock.agentRequests({ promptMarker: prompt })).every((request) => request.toolName !== "skill")
      : call.status === "error" && reason.includes(`Your organization's agent permissions block the local skill "${folderSkills.blocked.name}" (set for Contractors)`);
    evidence.recordAssertionEvidence("the notes-helper skill", call === null
      ? "not offered to the agent, and the agent loaded no skill"
      : `${call.status}; the agent was told: ${reason || "(nothing)"}`, kept);
    expect(kept).toBe(true);
    await user.screenshot();
  });

  await step("adding a local skill in OpenWork is refused with the Contractors rule", async () => {
    const added = await agent.desktopApi(`/workspace/${encodeURIComponent(world.app.workspaceId)}/skills`, {
      method: "POST", body: { name: "meeting-notes", description: "Summarize meeting notes.", content: "Summarize the meeting notes." },
    });
    const message = JSON.stringify(added.body);
    evidence.recordAssertionEvidence("adding meeting-notes", `HTTP ${added.status} ${message}`,
      added.status === 403 && message.includes('block the local skill \\"meeting-notes\\" (set for Contractors)'));
    expect(added.status).toBe(403);
    expect(message).toContain('block the local skill \\"meeting-notes\\" (set for Contractors)');
  });

  await step("before: the built-in browser opens the briefing page, which Contractors allow", async () => {
    const tab = await world.openTab(world.briefingUrl);
    await user.see({ placeholder: "Enter URL..." }, { timeoutMs: 30_000 });
    const served = await world.servedPages();
    evidence.recordAssertionEvidence("the briefing tab", `${tab.label}; load error: ${tab.loadError ?? "none"}; pages served: ${served.join(", ")}`,
      tab.label === "Project briefing" && tab.loadError === null && served.includes("/briefing"));
    expect(tab.label).toBe("Project briefing");
    expect(tab.loadError).toBeNull();
    expect(served).toContain("/briefing");
    await user.screenshot();
  });

  await step("after: typing the private report's address shows the Contractors rule that blocks it, and the page is never requested", async () => {
    await user.type({ placeholder: "Enter URL..." }, world.reportUrl, { replace: true });
    await user.press("Enter");
    const message = `Your organization's agent permissions block opening ${world.reportUrl} (set for Contractors).`;
    await user.see({ text: message }, { timeoutMs: 30_000 });
    const served = await world.servedPages();
    evidence.recordAssertionEvidence("the private report in the built-in browser", `shown: ${message}; pages served: ${served.join(", ")}`, !served.includes("/private-report"));
    expect(served).not.toContain("/private-report");
    await user.screenshot();
  });
});
