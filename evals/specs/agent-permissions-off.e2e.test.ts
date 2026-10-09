import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { randomUUID } from "node:crypto";
import { agentPermissionsDesktopFeatureOff, folderSkills } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsDesktopFeatureOff, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Agent permissions reach a member's agent only through the desktop app's local OpenWork server and Electron browser, so proving they stay out of the way needs that app signed in to Den.",
  },
  needs: { placement: "local" },
});

test("a member of an organization without agent permissions keeps their skills, MCP servers and built-in browser as before", async ({ world, user, agent, step, probe, evidence }) => {
  const loadSkill = (name: string): MockAgentToolStep[] => world.engine === "v2"
    ? [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: name } }]
    : [{ tool: "skill", arguments: { name } }];
  const isSkill = (name: string) => (input: Record<string, unknown>) => input.name === name || input.id === name;

  await step("given Riley's organization has not turned agent permissions on, Den sends no rules and the app enforces none", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const received = await world.receivedRules("riley");
    const enforced = await world.enforcedRules();
    evidence.recordAssertionEvidence(`rules Riley's app receives and enforces (${world.engine})`,
      `received: ${received === null ? "none" : JSON.stringify(received)}; enforced: ${enforced.length}`, received === null && enforced.length === 0);
    expect(received).toBeNull();
    expect(enforced).toEqual([]);
    await user.screenshot();
  });

  await step("the agent loads the folder's notes skill, as it always has", async () => {
    const prompt = `Use the notes helper. ${randomUUID()}`;
    await world.prepareTurn(prompt, `Notes loaded. ${randomUUID()}`, loadSkill(folderSkills.blocked.name), "last-tool-text");
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: new RegExp(folderSkills.blocked.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }, { timeoutMs: 120_000 });
    const call = await world.toolCall("skill", isSkill(folderSkills.blocked.name));
    evidence.recordAssertionEvidence("the notes-helper skill", `${call?.status ?? "none"}; its steps reached the agent`, call?.status === "completed");
    expect(call?.status).toBe("completed");
    await user.screenshot();
  });

  await step("the folder's MCP server stays on, and adding a local skill and an MCP server works", async () => {
    const server = await probe.eventually(() => world.notesServerStatus(), {
      within: 60_000, label: "the engine reports the folder's MCP server", until: (status) => status !== null,
    });
    const workspace = encodeURIComponent(world.app.workspaceId);
    const skill = await agent.desktopApi(`/workspace/${workspace}/skills`, {
      method: "POST", body: { name: "meeting-notes", description: "Summarize meeting notes.", content: "Summarize the meeting notes." },
    });
    const mcp = await agent.desktopApi(`/workspace/${workspace}/mcp`, {
      method: "POST", body: { name: "issue-tracker", config: { type: "remote", url: "http://127.0.0.1:9/issues" } },
    });
    const ok = server !== "disabled" && skill.status < 300 && mcp.status < 300;
    evidence.recordAssertionEvidence("local skills and MCP servers",
      `notes-server: ${String(server)}; adding meeting-notes → HTTP ${skill.status}; adding issue-tracker → HTTP ${mcp.status}`, ok);
    expect(server).not.toBe("disabled");
    expect(skill.status).toBeLessThan(300);
    expect(mcp.status).toBeLessThan(300);
  });

  await step("the built-in browser opens any page without waiting for rules", async () => {
    const tab = await world.openTab(world.reportUrl);
    await user.see({ placeholder: "Enter URL..." }, { timeoutMs: 30_000 });
    const served = await world.servedPages();
    evidence.recordAssertionEvidence("the private report tab", `${tab.label}; load error: ${tab.loadError ?? "none"}; pages served: ${served.join(", ")}`,
      tab.loadError === null && served.includes("/private-report"));
    expect(tab.loadError).toBeNull();
    expect(served).toContain("/private-report");
    await user.screenshot();
  });
});
