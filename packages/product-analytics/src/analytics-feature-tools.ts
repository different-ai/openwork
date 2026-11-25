import { nativeSkillAnalyticsIdentity, type FeatureAnalytics } from "./analytics-features.js";

type ToolUpdate = {
  id: string;
  sessionID: string;
  messageID: string;
  tool: string;
  state: { status: string; input: unknown; output?: unknown; metadata?: unknown };
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return isRecord(value) ? value : null;
}
function result(value: unknown): Record<string, unknown> | null {
  const parsed = record(value);
  if (!parsed) return null;
  if (parsed.isError === true || parsed.ok === false) return parsed;
  if (Array.isArray(parsed.content)) {
    for (const item of parsed.content) {
      const text = record(item)?.text;
      const nested = typeof text === "string" ? record(text) : null;
      if (nested) return nested;
    }
  }
  return parsed;
}
function succeeded(output: unknown) {
  const parsed = result(output);
  return parsed?.ok !== false && parsed?.isError !== true;
}


export function createFeatureToolObserver(analytics: FeatureAnalytics) {
  const observed = new WeakMap<object, Set<string>>();
  return (owner: object, part: ToolUpdate) => {
    let seen = observed.get(owner);
    if (!seen) { seen = new Set(); observed.set(owner, seen); }
    const parent = JSON.stringify([part.sessionID, part.messageID, part.id]);
    const emit = (key: string, tool: string, status: string, input: unknown, output: unknown, metadata?: unknown) => {
      if (seen.has(key)) return;
      const isSubagent = tool === "task" || tool === "subagent";
      if (status !== "completed" && !(isSubagent && status === "running")) return;
      const details = record(metadata);
      const started = isSubagent && status === "running" && typeof details?.sessionId === "string";
      if (!started && (status !== "completed" || !succeeded(output))) return;
      seen.add(key);
      const args = record(input);
      if (isSubagent) { analytics.subagentStarted(args?.background === true); return; }
      if (tool === "skill") { analytics.skillInvoked(nativeSkillAnalyticsIdentity(args?.id ?? args?.name)); return; }
      const cloud = /^openwork(?:-cloud)?[_.]/.test(tool);
      if (cloud && /[_.]get_skill$/.test(tool)) { analytics.skillInvoked({ skill_source: "organization" }); return; }
      if (cloud && /[_.]create_skill$/.test(tool)) { analytics.skillCreated({ skill_source: "organization" }); return; }
      if (tool === "openwork_execute" && args?.id === "automation.propose") { analytics.automationProposed(); return; }
      if (tool === "openwork_execute" && args?.id === "browser.open_url") { analytics.browserOpened(); return; }
      if (tool === "openwork_execute" && typeof args?.id === "string" && args.id.startsWith("browser.")) { analytics.browserUsed(); return; }
      if (cloud && /[_.]create_app$/.test(tool)) { analytics.artifactCreated(); return; }
      if (cloud) {
        if (/[_.]execute_capability$/.test(tool) && typeof args?.name === "string") {
          if (args.name.startsWith("skill:")) analytics.skillInvoked({ skill_source: "organization" });
          if (/^(?:mcp|native):/.test(args.name)) analytics.connectorToolCalled();
        }
        return;
      }
      if (tool === "browser_open") { analytics.browserOpened(); return; }
      if (/^browser_(?:act|extract|observe|tabs|handoff|navigate)$/.test(tool)) { analytics.browserUsed(); return; }
      if (tool === "computer_open") { analytics.computerOpened(); return; }
      if (/^computer_(?:act|run|script|observe|zoom)$/.test(tool)) { analytics.computerUsed(); return; }
      if (tool === "webmcp_call_tool") { analytics.browserUsed(); return; }
      if ((tool.includes("_") || tool.includes(".")) && !["ask_without_waiting", "multi_tool_use", "enter_plan_mode", "exit_plan_mode"].includes(tool)
        && !/^(?:browser|computer|webmcp)_/.test(tool)) analytics.connectorToolCalled();
    };
    const metadata = record(part.state.metadata);
    emit(parent, part.tool, part.state.status, part.state.input,
      metadata?.openworkMcpResult ?? metadata?.openworkMcpApp ?? part.state.output, part.state.metadata);
    if (part.tool !== "execute" || !Array.isArray(metadata?.openworkToolDetails)) return;
    for (const value of metadata.openworkToolDetails) {
      const detail = record(value);
      if (!detail || typeof detail.invocationId !== "string" || typeof detail.tool !== "string" || typeof detail.status !== "string") continue;
      emit(`${parent}:${detail.invocationId}`, detail.tool, detail.status, detail.input, detail.output);
    }
  };
}
