import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentPermissionsDesktop } from "../worlds/agent-permissions.ts";

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

test("a contractor's agent asks before commands, runs the ones the team allows, and cannot run blocked commands, edit files, open blocked websites or use the folder's MCP server", async ({ world, user, agent, probe, step, evidence }) => {
  // The member's approval prompt, on either engine.
  const approval = "Allow once";
  /** Sends a prompt the witness model answers by calling `steps`, approving one prompt first when asked to. */
  const turn = async (label: string, steps: MockAgentToolStep[], options: { approve?: boolean } = {}) => {
    const prompt = `${label} ${randomUUID()}`;
    const reply = `${label} done. ${randomUUID()}`;
    await world.prepareTurn(prompt, reply, steps);
    await user.type("composer", prompt);
    await user.click("Run task");
    if (options.approve) {
      await user.see(approval, { timeoutMs: 120_000 });
      await user.screenshot();
      await user.click(approval);
    }
    await user.see({ text: reply }, { timeoutMs: 120_000 });
    return prompt;
  };
  const settled = (tool: string, matches: (input: Record<string, unknown>) => boolean) => probe.eventually(() => world.toolCall(tool, matches), {
    within: 60_000, label: `the ${tool} call settled in the engine`, until: (call) => call !== null,
  });
  const reason = (call: { error: string; output: string } | null) => `${call?.error ?? ""} ${call?.output ?? ""}`.trim();
  const shell = (command: string): MockAgentToolStep => ({ tool: world.shellTool, arguments: { command, description: "Run a command" } });
  const blockedCommand = "printf '%s' 'saved by the agent' > 'note.txt'";
  const allowedCommand = "echo 'checked in'";
  const askedCommand = "pwd";

  await step("given Riley's desktop app enforces the Contractors permissions", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const rules = await probe.eventually(() => world.enforcedRules(), {
      within: 60_000, label: "Riley's OpenWork has the Contractors rules", until: (found) => found.length > 0,
    });
    const expected = [
      ["shell", "*", "ask"], ["shell", "echo *", "allow"], ["shell", "printf *", "deny"],
      ["edit", "*", "deny"],
      ["webfetch", "*", "deny"], ["webfetch", "127.0.0.1/briefing", "allow"],
      ["skill", "*", "deny"], ["skill", "team-*", "allow"],
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

  await step("the agent cannot write a file, because Contractors block file edits", async () => {
    const draft = join(world.workspacePath, "draft.md");
    // Where an engine stops offering file tools, the witness still calls one, as a misbehaving model would.
    const prompt = await turn("Write a short draft in this folder.", [{
      tool: "write", arguments: { filePath: draft, path: "draft.md", content: "A draft the agent should not save." }, allowUnadvertisedTool: true,
    }]);
    const offered = (await world.offeredTools(prompt)).filter((tool) => ["write", "edit", "patch", "apply_patch", "multiedit"].includes(tool));
    const call = await world.toolCall("write", () => true);
    const wrote = await world.wrote("draft.md");
    const told = reason(call);
    const blocked = offered.length === 0 || (call?.status === "error" && told.includes("Your organization's agent permissions block editing files (set for Contractors)"));
    evidence.recordAssertionEvidence("the agent's file write", offered.length === 0
      ? `draft written: ${wrote}; the engine offered the agent no file-editing tool`
      : `draft written: ${wrote}; ${call?.status ?? "none"}; the agent was told: ${told || "(nothing)"}`, !wrote && blocked);
    expect(wrote).toBe(false);
    expect(blocked).toBe(true);
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
    const message = JSON.stringify(added.body);
    evidence.recordAssertionEvidence("local MCP servers", `notes-server: ${String(server)}; adding issue-tracker → HTTP ${added.status} ${message}`,
      server === "disabled" && added.status === 403 && message.includes('block the local MCP server \\"issue-tracker\\" (set for Contractors)'));
    expect(server).toBe("disabled");
    expect(added.status).toBe(403);
    expect(message).toContain('block the local MCP server \\"issue-tracker\\" (set for Contractors)');
  });
});
