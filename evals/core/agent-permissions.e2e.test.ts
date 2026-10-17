import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runToolTurn } from "@openwork/behaviors";
import { agentPermissionsDesktop, contractorDesktopPermissions, folderSkills } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsDesktop, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Agent permissions reach a member's agent through the desktop app, which gives its local OpenWork server the member's Den session; the web build has no host token to do that.",
  },
  needs: { placement: "local" },
});

function describeRules(rules: Record<string, unknown>[]): string {
  return rules.map((rule) => `${String(rule.action)} ${String(rule.resource)} → ${String(rule.effect)} (${String(rule.source)})`).join("; ") || "none";
}

test("a contractor's agent asks before commands, runs the ones the team allows, and cannot run blocked commands, edit files without asking, open blocked websites or use the folder's MCP server", async ({ world, user, agent, probe, step, evidence }) => {
  const approval = "Allow once";
  const turn = (label: string, steps: MockAgentToolStep[], options: { approve?: boolean; deny?: boolean } = {}) => runToolTurn({ user }, world, label, steps, options);
  const settled = (tool: string, matches: (input: Record<string, unknown>) => boolean) => probe.eventually(() => world.toolCall(tool, matches), {
    within: 60_000, label: `the ${tool} call settled in the engine`, until: (call) => call !== null,
  });
  const loadSkill = (name: string): MockAgentToolStep[] => [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: name } }];
  const isSkill = (name: string) => (input: Record<string, unknown>) => input.name === name || input.id === name || input.skill === name;
  const reason = (call: { error: string; output: string } | null) => `${call?.error ?? ""} ${call?.output ?? ""}`.trim();
  const shell = (command: string): MockAgentToolStep => ({ tool: world.shellTool, arguments: { command, description: "Run a command" } });
  const blockedCommand = "printf '%s' 'saved by the agent' > 'note.txt'";
  const wrappedCommand = `bash -c "printf '%s' 'saved through bash' > 'wrapped-note.txt'"`;
  const variableCommand = "x=printf; $x '%s' 'saved through a variable' > 'variable-note.txt'";
  const allowedCommand = "echo 'checked in'";
  const askedCommand = "pwd";

  await step("given Riley's desktop app enforces the Contractors permissions", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const rules = await probe.eventually(() => world.enforcedRules(), {
      within: 60_000, label: "Riley's OpenWork has the Contractors rules", until: (found) => found.length > 0,
    });
    const expected = [
      ["shell", "*", "ask"], ["shell", "echo *", "allow"], ["shell", "printf *", "deny"],
      ["edit", "*", "ask"],
      ["webfetch", "*", "deny"], ["webfetch", "127.0.0.1/briefing", "allow"],
      ["skill", "*", "deny"],
      ["mcp", "*", "deny"],
    ].map(([action, resource, effect]) => ({ action, resource, effect, source: "Contractors" }));
    evidence.recordAssertionEvidence(`rules Riley's OpenWork enforces (${world.engine})`, describeRules(rules), JSON.stringify(rules) === JSON.stringify(expected));
    expect(rules).toEqual(expected);
    await user.screenshot();
  });

  await step("before: the agent tries to save a note with printf, which Contractors always block", async () => {
    await turn("Save a short note in this folder.", [shell(blockedCommand)]);
    const call = await settled(world.shellTool, (input) => input.command === blockedCommand);
    evidence.recordAssertionEvidence("the agent's printf call", `${call?.status ?? "none"}: ${blockedCommand}`, call?.status === "error");
    expect(call?.status).toBe("error");
    await user.screenshot();
  });

  await step("after: printf never ran, and the agent was told the Contractors rule that blocks it", async () => {
    const call = await world.toolCall(world.shellTool, (input) => input.command === blockedCommand);
    const wrote = await world.wrote("note.txt");
    const told = reason(call);
    evidence.recordAssertionEvidence("blocked before it ran", `note written: ${wrote}; the agent was told: ${told || "(nothing)"}`,
      !wrote && told.includes("Your organization's agent permissions block") && told.includes('"printf *" is blocked for Contractors'));
    expect(wrote).toBe(false);
    expect(told).toContain("Your organization's agent permissions block");
    expect(told).toContain('"printf *" is blocked for Contractors');
  });

  await step("before: the agent hands the same printf to another shell with bash -c", async () => {
    await turn("Save the note through bash.", [shell(wrappedCommand)]);
    const call = await settled(world.shellTool, (input) => input.command === wrappedCommand);
    evidence.recordAssertionEvidence("the agent's bash -c call", `${call?.status ?? "none"}: ${wrappedCommand}`, call?.status === "error");
    expect(call?.status).toBe("error");
    await user.screenshot();
  });

  await step("after: the wrapped printf never ran either, and the agent was told the same rule", async () => {
    const call = await world.toolCall(world.shellTool, (input) => input.command === wrappedCommand);
    const wrote = await world.wrote("wrapped-note.txt");
    const told = reason(call);
    evidence.recordAssertionEvidence("wrapped command blocked before it ran", `note written: ${wrote}; the agent was told: ${told || "(nothing)"}`,
      !wrote && told.includes('"printf *" is blocked for Contractors'));
    expect(wrote).toBe(false);
    expect(told).toContain('"printf *" is blocked for Contractors');
  });

  await step("before: the agent names printf through a shell variable it sets on the same line", async () => {
    await turn("Save the note through a variable.", [shell(variableCommand)]);
    const call = await settled(world.shellTool, (input) => input.command === variableCommand);
    await user.notSee(approval);
    evidence.recordAssertionEvidence("the agent's variable-named printf call", `${call?.status ?? "none"}, no approval asked: ${variableCommand}`, call?.status === "error");
    expect(call?.status).toBe("error");
    await user.screenshot();
  });

  await step("after: the variable-named printf never ran, and the agent was told the Contractors rule instead of Riley being asked to approve it", async () => {
    const call = await world.toolCall(world.shellTool, (input) => input.command === variableCommand);
    const wrote = await world.wrote("variable-note.txt");
    const told = reason(call);
    evidence.recordAssertionEvidence("variable-named command blocked before it ran", `note written: ${wrote}; the agent was told: ${told || "(nothing)"}`,
      !wrote && told.includes('"printf *" is blocked for Contractors'));
    expect(wrote).toBe(false);
    expect(told).toContain('"printf *" is blocked for Contractors');
  });

  await step("an echo command, which Contractors always allow, runs without asking Riley", async () => {
    await turn("Say that you checked in.", [shell(allowedCommand)]);
    const call = await settled(world.shellTool, (input) => input.command === allowedCommand);
    await user.notSee(approval);
    evidence.recordAssertionEvidence("the allowed echo call", `${call?.status ?? "none"}, no approval asked: ${allowedCommand}`, call?.status === "completed");
    expect(call?.status).toBe("completed");
    await user.screenshot();
  });

  await step("any other command asks Riley first, and runs once Riley allows it", async () => {
    await turn("Show which folder you are in.", [shell(askedCommand)], { approve: true });
    const call = await settled(world.shellTool, (input) => input.command === askedCommand);
    evidence.recordAssertionEvidence("the pwd call after Riley allowed it once", `${call?.status ?? "none"}: ${askedCommand}`, call?.status === "completed");
    expect(call?.status).toBe("completed");
    await user.screenshot();
  });

  await step("the agent asks Riley before writing a file, because Contractors ask first for file edits, and nothing is written when Riley denies it", async () => {
    const draft = join(world.workspacePath, "draft.md");
    await turn("Write a short draft in this folder.", [{
      tool: "write", arguments: { filePath: draft, path: "draft.md", content: "A draft Riley did not approve." },
    }], { deny: true });
    const call = await settled("write", () => true);
    const wrote = await world.wrote("draft.md");
    evidence.recordAssertionEvidence("the agent's file write after Riley denied it", `draft written: ${wrote}; ${call?.status ?? "none"}`, !wrote && call?.status === "error");
    expect(wrote).toBe(false);
    expect(call?.status).toBe("error");
    await user.screenshot();
  });

  await step("the agent can read the briefing page on Riley's computer, but not the private report next to it", async () => {
    await turn("Read the briefing and the report.", [
      { tool: "webfetch", arguments: { url: world.reportUrl, format: "text" } },
      { tool: "webfetch", arguments: { url: world.briefingUrl, format: "text" } },
    ]);
    const report = await settled("webfetch", (input) => input.url === world.reportUrl);
    const briefing = await settled("webfetch", (input) => input.url === world.briefingUrl);
    const served = await world.servedPages();
    const told = reason(report);
    evidence.recordAssertionEvidence("the agent's web fetches", `report: ${report?.status ?? "none"} (${told || "no reason"}); briefing: ${briefing?.status ?? "none"}; pages served: ${served.join(", ") || "none"}`,
      report?.status === "error" && briefing?.status === "completed" && served.includes("/briefing") && !served.includes("/private-report"));
    expect(report?.status).toBe("error");
    expect(told).toContain(`Your organization's agent permissions block opening ${world.reportUrl} (set for Contractors)`);
    expect(briefing?.status).toBe("completed");
    expect(briefing?.output ?? "").toContain("Project briefing");
    expect(served).toContain("/briefing");
    expect(served).not.toContain("/private-report");
    await user.screenshot();
  });

  await step("the folder's own MCP server is turned off for Riley, and adding a local MCP server in OpenWork is refused", async () => {
    const server = await probe.eventually(() => world.notesServerStatus(), {
      within: 60_000, label: "the engine reports the folder's MCP server", until: (status) => status !== null,
    });
    const added = await agent.desktopApi(`/workspace/${encodeURIComponent(world.app.workspaceId)}/mcp`, {
      method: "POST", body: { name: "issue-tracker", config: { type: "remote", url: "http://127.0.0.1:9/issues" } },
    });
    const skillAdded = await agent.desktopApi(`/workspace/${encodeURIComponent(world.app.workspaceId)}/skills`, {
      method: "POST", body: { name: "meeting-notes", description: "Summarize meeting notes.", content: "Summarize the meeting notes." },
    });
    const message = JSON.stringify(added.body);
    evidence.recordAssertionEvidence("local MCP servers and skills", `notes-server: ${String(server)}; adding issue-tracker → HTTP ${added.status} ${message}; adding a skill → HTTP ${skillAdded.status}`,
      server === "disabled" && added.status === 403 && skillAdded.status === 403 && message.includes('block the local MCP server \\"issue-tracker\\" (set for Contractors)'));
    expect(server).toBe("disabled");
    expect(added.status).toBe(403);
    expect(message).toContain('block the local MCP server \\"issue-tracker\\" (set for Contractors)');
    expect(skillAdded.status).toBe(403);
    expect(JSON.stringify(skillAdded.body)).toContain('block the local skill \\"meeting-notes\\" (set for Contractors)');
    expect(await world.mcpServers()).toHaveProperty("openwork-cloud");
  });

  await step("the folder's own skill never reaches the agent while Contractors block local skills", async () => {
    const prompt = `Use the ${folderSkills.blocked.name} skill. ${randomUUID()}`;
    await world.prepareTurn(prompt, `Skill unavailable. ${randomUUID()}`, loadSkill(folderSkills.blocked.name));
    await user.type("composer", prompt);
    await user.click("Run task");
    // v2 may offer no skill tool at all, so the scripted model ends the turn with an error instead of a reply.
    await probe.eventually(async () => (await world.mock.agentRequests({ promptMarker: prompt })).some((request) => request.kind === "final" || request.kind === "error"),
      { within: 120_000, label: "the blocked-skill turn ends", until: Boolean });
    await user.notSee({ text: folderSkills.blocked.marker });
    const call = await world.toolCall("skill", isSkill(folderSkills.blocked.name));
    expect(call === null || (call.status === "error" && reason(call).includes(`block the local skill "${folderSkills.blocked.name}" (set for Contractors)`))).toBe(true);
    await user.screenshot();
  });

  await step("the built-in browser opens the allowed briefing and shows the blocked-site page for the private report", async () => {
    const tab = await world.openTab(world.briefingUrl);
    expect(tab.label).toBe("Project briefing");
    await user.type({ placeholder: "Enter URL..." }, world.reportUrl, { replace: true });
    await user.press("Enter");
    await user.see({ text: "Your organization doesn't allow you to view this site." }, { timeoutMs: 30_000 });
    expect(await world.servedPages()).not.toContain("/private-report");
    await user.screenshot();
  });

  const restartedCommand = "printf '%s' 'saved after the restart' > 'restart-note.txt'";

  await step("before: Riley's engine restarts with the Contractors rules already stored, and starts", async () => {
    const restarted = await world.restartEngine();
    evidence.recordAssertionEvidence(`the ${world.engine} engine after a restart with stored rules`, restarted.running ? "running" : `not running: ${restarted.error ?? "unknown"}`, restarted.running);
    expect(restarted.running).toBe(true);
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await user.screenshot();
  });

  await step("after: the restarted engine still blocks printf before it runs", async () => {
    await turn("Save a note after the restart.", [shell(restartedCommand)]);
    const call = await settled(world.shellTool, (input) => input.command === restartedCommand);
    const wrote = await world.wrote("restart-note.txt");
    const told = reason(call);
    evidence.recordAssertionEvidence("printf after the restart", `note written: ${wrote}; the agent was told: ${told || "(nothing)"}`,
      !wrote && call?.status === "error" && told.includes('"printf *" is blocked for Contractors'));
    expect(wrote).toBe(false);
    expect(call?.status).toBe("error");
    expect(told).toContain('"printf *" is blocked for Contractors');
    await user.screenshot();
  });

  await step("after the owner allows local skills and MCP servers for Contractors, the folder's server connects and its skill loads", async () => {
    await world.saveContractors({ ...contractorDesktopPermissions, localSkills: { decision: "allow" }, localMcpServers: { decision: "allow" } });
    await probe.eventually(async () => (await world.enforcedRules()).filter((rule) => rule.action === "skill" || rule.action === "mcp"), {
      within: 60_000, label: "Riley's OpenWork drops the local skill and MCP blocks", until: (found) => found.length === 0,
    });
    await probe.eventually(() => world.notesServerStatus(), { within: 120_000, label: "the folder's MCP server connects", until: (status) => status === "connected" });
    const prompt = `Follow the team checklist. ${randomUUID()}`;
    await world.prepareTurn(prompt, `Checklist loaded. ${randomUUID()}`, loadSkill(folderSkills.allowed.name), "last-tool-text");
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: new RegExp(folderSkills.allowed.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }, { timeoutMs: 120_000 });
    await user.screenshot();
  });
});
