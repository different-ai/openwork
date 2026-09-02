import { expect } from "vitest";
import { spec, type Probe, type Seed } from "@openwork/testkit";
import { liveToolSwitch } from "../worlds/chat.ts";

interface ToolFact {
  callId: string;
  status: string;
  command: string;
  description: string;
}

interface SessionFacts {
  text: string;
  tools: ToolFact[];
}

interface VisibleTool {
  currentSessionId: string;
  found: boolean;
  visible: boolean;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionFacts(value: unknown): SessionFacts {
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.tools)) throw new Error(`Invalid session facts: ${JSON.stringify(value)}`);
  return {
    text: value.text,
    tools: value.tools.flatMap((tool) => isRecord(tool) ? [{
      callId: typeof tool.callId === "string" ? tool.callId : "",
      status: typeof tool.status === "string" ? tool.status : "",
      command: typeof tool.command === "string" ? tool.command : "",
      description: typeof tool.description === "string" ? tool.description : "",
    }] : []),
  };
}

async function sessionFacts(probe: Probe, workspaceId: string, sessionId: string): Promise<SessionFacts> {
  // TODO(primitive): read local engine session parts and tool states.
  const value = await probe.eval(`(() => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/session/" + encodeURIComponent(${JSON.stringify(sessionId)}) + "/message";
    const request = new XMLHttpRequest();
    request.open("GET", base, false);
    request.setRequestHeader("Authorization", "Bearer " + token);
    request.send();
    if (request.status < 200 || request.status >= 300) throw new Error("Session facts failed: " + request.status);
    const messages = JSON.parse(request.responseText);
    const parts = Array.isArray(messages) ? messages.flatMap((message) => Array.isArray(message?.parts) ? message.parts : []) : [];
    return {
      text: parts.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("\\n"),
      tools: parts.flatMap((part) => {
        if (!part || typeof part.tool !== "string") return [];
        const state = part.state && typeof part.state === "object" ? part.state : {};
        const input = state.input && typeof state.input === "object" ? state.input : {};
        return [{
          callId: typeof part.callID === "string" ? part.callID : "",
          status: typeof state.status === "string" ? state.status : "",
          command: typeof input.command === "string" ? input.command : "",
          description: typeof input.description === "string" ? input.description : "",
        }];
      }),
    };
  })()`);
  return parseSessionFacts(value);
}

async function approve(seed: Seed, app: Awaited<ReturnType<Seed["desktop"]>>, workspaceId: string, sessionId: string): Promise<number> {
  // TODO(primitive): approve pending local engine permissions as mid-flow arranged state.
  const value = await seed.evalIn(app, `(() => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const root = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode";
    const send = (method, url, body) => {
      const request = new XMLHttpRequest();
      request.open(method, url, false);
      request.setRequestHeader("Authorization", "Bearer " + token);
      request.setRequestHeader("Content-Type", "application/json");
      request.send(body);
      return request;
    };
    const pending = send("GET", root + "/api/session/" + encodeURIComponent(${JSON.stringify(sessionId)}) + "/permission");
    if (pending.status < 200 || pending.status >= 300) return -1;
    const requests = JSON.parse(pending.responseText);
    let count = 0;
    for (const request of Array.isArray(requests) ? requests : []) {
      if (typeof request?.id !== "string") continue;
      const response = send("POST", root + "/api/session/" + encodeURIComponent(${JSON.stringify(sessionId)}) + "/permission/" + encodeURIComponent(request.id) + "/reply", JSON.stringify({ reply: "once" }));
      if (response.status < 200 || response.status >= 300) throw new Error("Permission approval failed: " + response.status);
      count += 1;
    }
    return count;
  })()`);
  if (typeof value !== "number") throw new Error("Permission approval count was invalid.");
  return value;
}

async function visibleTool(probe: Probe, sessionId: string, callId: string): Promise<VisibleTool> {
  // TODO(primitive): inspect visibility of a scoped live-tool row.
  const value = await probe.eval(`(() => {
    const surface = document.querySelector(${JSON.stringify(`[data-session-surface-id="${sessionId}"]`)});
    const currentSessionId = document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "";
    if (!(surface instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, text: "" };
    const row = surface.querySelector('[data-tool-aggregate="' + CSS.escape(${JSON.stringify(callId)}) + '"]');
    if (!(row instanceof HTMLElement)) return { currentSessionId, found: false, visible: false, text: "" };
    const rect = row.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const style = getComputedStyle(row);
    return {
      currentSessionId,
      found: true,
      visible: row.isConnected
        && rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && rect.bottom > Math.max(0, surfaceRect.top)
        && rect.top < Math.min(window.innerHeight, surfaceRect.bottom)
        && rect.right > Math.max(0, surfaceRect.left)
        && rect.left < Math.min(window.innerWidth, surfaceRect.right),
      text: row.innerText ?? "",
    };
  })()`);
  if (!isRecord(value)) throw new Error("Visible tool fact was invalid.");
  return {
    currentSessionId: typeof value.currentSessionId === "string" ? value.currentSessionId : "",
    found: value.found === true,
    visible: value.visible === true,
    text: typeof value.text === "string" ? value.text : "",
  };
}

const test = spec.world(liveToolSwitch, { timeout: 12 * 60_000 });

test("a tool started while away is visible after returning to its chat", async ({ world, user, seed, probe }) => {
  await user.type("composer", `Run the deterministic tool identified by ${world.promptMarker}.`);
  await user.click("Run task");

  const running = await probe.eventually(async () => {
    await approve(seed, world.app, world.workspaceA.workspaceId, world.sessionA.sessionId);
    return sessionFacts(probe, world.workspaceA.workspaceId, world.sessionA.sessionId);
  }, {
    within: 90_000,
    intervalMs: 500,
    label: "Chat A first bash tool running",
    until: (facts) => facts.tools.some((tool) => tool.status === "running" && tool.command === world.firstCommand && tool.description === world.firstToolDescription),
  });
  const firstTool = running.tools.find((tool) => tool.command === world.firstCommand);
  if (!firstTool?.callId) throw new Error("The running first tool had no call ID.");
  const visibleBefore = await probe.eventually(() => visibleTool(probe, world.sessionA.sessionId, firstTool.callId), {
    within: 30_000,
    intervalMs: 250,
    label: "first tool visibly rendered",
    until: (fact) => fact.currentSessionId === world.sessionA.sessionId && fact.found && fact.visible,
  });
  expect(visibleBefore.visible).toBe(true);

  await user.click({ role: "button", label: /Chat B/ });
  const absentFromB = await visibleTool(probe, world.sessionB.sessionId, firstTool.callId);
  expect(absentFromB.currentSessionId).toBe(world.sessionB.sessionId);
  expect(absentFromB.found).toBe(false);

  const laterRunning = await probe.eventually(async () => {
    await approve(seed, world.app, world.workspaceA.workspaceId, world.sessionA.sessionId);
    return sessionFacts(probe, world.workspaceA.workspaceId, world.sessionA.sessionId);
  }, {
    within: 45_000,
    intervalMs: 500,
    label: "second Chat A tool starts while Chat B is visible",
    until: (facts) => facts.tools.some((tool) => tool.status === "completed" && tool.callId === firstTool.callId)
      && facts.tools.some((tool) => tool.status === "running" && tool.command === world.command && tool.description === world.toolDescription),
  });
  const laterTool = laterRunning.tools.find((tool) => tool.command === world.command);
  if (!laterTool?.callId) throw new Error("The later tool had no call ID.");

  await user.click({ role: "button", label: /Chat A/ });
  const visibleAfter = await probe.eventually(() => visibleTool(probe, world.sessionA.sessionId, laterTool.callId), {
    within: 30_000,
    intervalMs: 250,
    label: "tool started while away visibly rendered after returning",
    until: (fact) => fact.currentSessionId === world.sessionA.sessionId && fact.found && fact.visible,
  });
  expect(visibleAfter.text).toContain(world.completionMarker);
  await user.screenshot();

  const completed = await probe.eventually(() => sessionFacts(probe, world.workspaceA.workspaceId, world.sessionA.sessionId), {
    within: 90_000,
    intervalMs: 500,
    label: "Chat A unique bash tool completed",
    until: (facts) => facts.text.includes(world.completionMarker)
      && facts.tools.some((tool) => tool.status === "completed" && tool.command === world.command),
  });
  expect(completed.text).toContain(world.completionMarker);
  const visibleAfterCompletion = await probe.eventually(() => visibleTool(probe, world.sessionA.sessionId, laterTool.callId), {
    within: 30_000,
    intervalMs: 250,
    label: "completed tool remains visibly rendered",
    until: (fact) => fact.currentSessionId === world.sessionA.sessionId && fact.found && fact.visible,
  });
  expect(visibleAfterCompletion.visible).toBe(true);
});
