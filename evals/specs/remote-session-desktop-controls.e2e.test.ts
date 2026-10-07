import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { DenSession, Seed } from "@openwork/testkit";

// Sarah's own agent (an MCP client signed in to her organization) drives a
// task on her desktop through Den's remote-session tools. The desktop is the
// real signed-in app with its runner on. The organization model it runs is a
// witness: it holds the task's first reply open, so a stop has a running turn
// to cut, and it records the model every turn was sent to.
const STOP_TURN = "REMOTE-STOP-TURN";
const SWITCH_TURN = "REMOTE-SWITCH-TURN";
const KEEP_TURN = "REMOTE-KEEP-TURN";
const TEAMMATE_TURN = "TEAMMATE-TURN";
const STOP_REPLY = "This answer waits until the task is stopped.";
const SWITCH_REPLY = "Answered on the model the follow-up named.";
const KEEP_REPLY = "Answered on the model the session already uses.";
const START_MODEL = "start-model";
const SWITCHED_MODEL = "switched-model";
/** The install id the desktop registers its runner with. */
const RUNNER_ID_KEY = "openwork.automations.desktop-runner-id";
/** Den keys a registered desktop by an id scoped to its organization and member. */
const SCOPED_COMPUTER_ID = /^rnr_[0-9a-f]{64}$/;

type RemoteSessionAction = "targets" | "create" | "read" | "send" | "stop";

interface ToolResult {
  action: RemoteSessionAction;
  isError: boolean;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function mcpToken(seed: Seed, member: DenSession, organizationId: string): Promise<string> {
  const minted = await seed.api(member, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(minted.body) ? text(minted.body.token) : "";
  if (!minted.response.ok || !token) throw new Error(`MCP token for ${member.email} failed: HTTP ${minted.response.status}`);
  return token;
}

async function desktopRemoteSessions(seed: Seed) {
  const witness = seed.mock({
    agentWorkloads: [
      // Held until the task is stopped, so the stop has a running reply to cut.
      { promptMarker: STOP_TURN, latestUserTurn: true, finalReply: STOP_REPLY, finalReplyChunks: [STOP_REPLY], finalReplyInitiallyReleasedChunks: 0, steps: [] },
      { promptMarker: SWITCH_TURN, latestUserTurn: true, finalReply: SWITCH_REPLY, steps: [] },
      { promptMarker: KEEP_TURN, latestUserTurn: true, finalReply: KEEP_REPLY, steps: [] },
      // Answers only if a teammate's follow-up ever reaches Sarah's desktop.
      { promptMarker: TEAMMATE_TURN, latestUserTurn: true, finalReply: "A teammate reached this desktop.", steps: [] },
    ],
  });
  const den = await seed.den({
    org: {
      name: `Remote session controls ${Date.now()}`,
      admin: { name: "Avery Admin" },
      members: { sarah: { name: "Sarah" }, theo: { name: "Theo" } },
    },
    mocks: { model: witness },
  });
  const sarah = den.members.sarah;
  const theo = den.members.theo;
  const model = den.mocks.model;
  if (!sarah || !theo || !model) throw new Error("seed.den() did not provision Sarah, Theo, and the model witness");

  const orgs = await seed.api(den.admin, "/v1/me/orgs");
  const organizationId = isRecord(orgs.body) ? text(records(orgs.body.orgs)[0]?.id) : "";
  if (!organizationId) throw new Error(`Organization lookup failed: HTTP ${orgs.response.status}`);
  // Controlling a member's desktop from an agent is entitled like OpenWork
  // Cloud. The launched Den makes its admin a platform admin, who grants it.
  const access = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/openwork-web-access`, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, reason: "Remote session controls journey" }),
  });
  if (!access.response.ok) throw new Error(`OpenWork Web access grant failed: HTTP ${access.response.status}`);

  // One organization provider with two models, both served by the witness.
  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Team models",
      source: "custom",
      customConfig: {
        id: "team-models",
        name: "Team models",
        npm: "@ai-sdk/openai-compatible",
        api: `${model.url}/v1`,
        env: ["TEAM_MODELS_API_KEY"],
        models: [{ id: START_MODEL, name: "Start model" }, { id: SWITCHED_MODEL, name: "Switched model" }],
      },
      apiKey: "sk-team-models-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
  });
  const provider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  const providerId = text(provider?.id);
  if (created.response.status !== 201 || !providerId) {
    throw new Error(`Organization provider setup failed: HTTP ${created.response.status}`);
  }

  const sarahToken = await mcpToken(seed, sarah, organizationId);
  const theoToken = await mcpToken(seed, theo, organizationId);
  // Eval desktops keep the runner off so they never take real work; this journey is about it.
  const app = await seed.desktop({ den, as: "sarah", env: { OPENWORK_AUTOMATION_RUNNER: "on" } });
  return { app, apiUrl: den.ref.apiUrl, model, providerId, sarahToken, theoToken };
}

const test = spec.world(desktopRemoteSessions, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Remote sessions run on the desktop's own runner: only the signed-in Electron app registers it with Den, claims remote-session commands and requests, and runs them in its local engine.",
  },
});

let rpcId = 0;

/** One remote-session tool call through Den's MCP server, as a member's agent makes it. */
async function callRemoteSession(apiUrl: string, token: string, action: RemoteSessionAction, body: Record<string, unknown>): Promise<ToolResult> {
  rpcId += 1;
  const id = rpcId;
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "execute_capability", arguments: { name: `remote-session:${action}`, body } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`remote-session:${action} → HTTP ${response.status}: ${raw.slice(0, 300)}`);
  const result = rpcAnswer(raw, id)?.result;
  if (!isRecord(result)) throw new Error(`remote-session:${action} → ${raw.slice(0, 300)}`);
  return { action, isError: result.isError === true, payload: toolPayload(result) };
}

/** Streamable HTTP answers as JSON or as SSE frames; take the one for this request. */
function rpcAnswer(raw: string, id: number): Record<string, unknown> | null {
  const frames = raw.trimStart().startsWith("{")
    ? [raw]
    : raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5));
  for (const frame of frames) {
    try {
      const parsed: unknown = JSON.parse(frame);
      if (isRecord(parsed) && parsed.id === id) return parsed;
    } catch {
      // Not a JSON-RPC frame.
    }
  }
  return null;
}

function toolPayload(result: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const body = records(result.content).map((part) => text(part.text)).join("");
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Plain-text tool output.
  }
  return { text: body };
}

/** What a tool call answered, in its own words. */
function outcome(result: ToolResult): string {
  if (!result.isError) return text(result.payload.state) || "answered";
  const message = text(result.payload.message);
  return `${text(result.payload.error) || "error"}${message ? ` (${message})` : ""}`;
}

function onlineComputers(result: ToolResult): Record<string, unknown>[] {
  return records(result.payload.computers).filter((computer) => computer.online === true);
}

function lastAssistantText(result: ToolResult): string {
  return text(records(result.payload.messages).filter((message) => message.role === "assistant").at(-1)?.text);
}

function defaultModelId(body: unknown): string | null {
  return isRecord(body) && isRecord(body.model) && typeof body.model.modelID === "string" ? body.model.modelID : null;
}

function defaultModelPath(workspaceId: string): string {
  return `/workspace/${encodeURIComponent(workspaceId)}/default-model`;
}

test("a member's agent stops a task on her desktop and keeps its model across follow-ups, while a teammate holding the session id cannot", { timeout: 1_200_000 }, async ({ world, agent, probe, step, evidence }) => {
  const sarah = (action: RemoteSessionAction, body: Record<string, unknown>) => callRemoteSession(world.apiUrl, world.sarahToken, action, body);
  const theo = (action: RemoteSessionAction, body: Record<string, unknown>) => callRemoteSession(world.apiUrl, world.theoToken, action, body);

  /** Polls until `until` holds and keeps the last answer either way, so a step can say what it saw. */
  const observe = async <T>(label: string, within: number, intervalMs: number, read: () => Promise<T>, until: (value: T) => boolean) => {
    const seen: { last?: T } = {};
    const done = await probe.eventually(async () => {
      const value = await read();
      seen.last = value;
      return value;
    }, { within, intervalMs, label, until }).then(() => true, () => false);
    return { done, last: seen.last };
  };

  /** A desktop that has not answered within Den's wait returns a request id to collect the answer with. */
  const answered = async (result: ToolResult): Promise<ToolResult> => {
    const requestId = text(result.payload.requestId);
    if (result.isError || result.payload.state !== "pending" || !requestId) return result;
    const collected = await observe(`the desktop answers ${result.action}`, 90_000, 2_000,
      () => sarah("read", { requestId }), (next) => next.isError || next.payload.state !== "pending");
    return collected.last ?? result;
  };

  /** The model a turn was sent to, as the model provider saw it. */
  const turnModel = async (marker: string): Promise<string | null> => {
    const asked = await observe(`the model is asked for ${marker}`, 60_000, 1_000,
      () => world.model.agentRequests({ promptMarker: marker }), (requests) => requests.some((request) => request.kind !== "utility"));
    return asked.last?.find((request) => request.kind !== "utility")?.model ?? null;
  };

  /** Sarah's transcript once the desktop has finished answering with `reply`. */
  const finished = (sessionId: string, reply: string) => observe(`the desktop finishes "${reply}"`, 90_000, 2_000,
    async () => answered(await sarah("read", { sessionId })),
    (read) => !read.isError && read.payload.status === "idle" && lastAssistantText(read).includes(reply));

  const computerId = await step("given: Sarah's desktop is connected to Den under its organization-scoped computer id", async () => {
    const listed = await observe("Sarah's desktop is listed online", 180_000, 3_000,
      () => sarah("targets", {}), (result) => onlineComputers(result).length > 0);
    const desktops = listed.last ? onlineComputers(listed.last) : [];
    const id = text(desktops[0]?.computerId);
    const installId = await probe.storage(RUNNER_ID_KEY);
    evidence.recordAssertionEvidence(
      "Sarah's desktop is registered under its organization-scoped computer id",
      desktops.length > 0
        ? `remote-session:targets → ${desktops.length} online computer, ${id}; the desktop registered it with install id ${String(installId)}`
        : `remote-session:targets → no online computer within 180 s (last answer: ${listed.last ? outcome(listed.last) : "none"})`,
      desktops.length === 1 && SCOPED_COMPUTER_ID.test(id) && typeof installId === "string" && installId !== id,
    );
    expect(desktops).toHaveLength(1);
    expect(id).toMatch(SCOPED_COMPUTER_ID);
    expect(typeof installId).toBe("string");
    expect(id).not.toBe(installId);
    return id;
  });

  const task = await step("when: her agent starts a task on that desktop and the model is still answering it", async () => {
    // New chats in Sarah's workspace start on Start model, as if she picked it; the task names no model.
    const chosen = await agent.desktopApi(defaultModelPath(world.app.workspaceId), {
      method: "PUT",
      body: { model: { providerID: world.providerId, modelID: START_MODEL } },
    });
    const queued = await sarah("create", { target: "desktop", title: "Quarterly notes", prompt: `${STOP_TURN} Summarize the quarterly notes.` });
    const commandId = text(queued.payload.commandId);
    const delivery = commandId
      ? await observe("the desktop takes the task", 240_000, 5_000, () => sarah("read", { commandId }),
        (read) => read.isError || ["delivered", "failed", "expired"].includes(text(read.payload.state)))
      : { done: false, last: undefined };
    const delivered = delivery.last;
    const streaming = delivered?.payload.state === "delivered"
      ? await observe("the model is answering the task", 60_000, 1_000,
        () => world.model.agentReplyState(STOP_TURN), (reply) => !reply.complete && !reply.aborted)
      : null;
    const sessionId = text(delivered?.payload.sessionId);
    const workspaceId = text(delivered?.payload.workspaceId);
    evidence.recordAssertionEvidence(
      "Sarah's desktop takes the task and the model is still answering it",
      `new chats in her workspace start on ${START_MODEL} (HTTP ${chosen.status}); remote-session:create → ${queued.isError ? outcome(queued) : `queued ${commandId}`}; `
        + (delivered
          ? `remote-session:read {commandId} → ${outcome(delivered)} on ${text(delivered.payload.computerId) || "no computer"} as session ${sessionId || "none"}; `
          : "the desktop never took it; ")
        + (streaming?.done && streaming.last
          ? `the model's reply is held at ${streaming.last.deliveredChunks} of ${streaming.last.totalChunks} chunks`
          : "the model never started answering"),
      chosen.status === 200 && delivered?.payload.state === "delivered" && text(delivered.payload.computerId) === computerId && streaming?.done === true,
    );
    expect(chosen.status).toBe(200);
    expect(queued.isError, outcome(queued)).toBe(false);
    expect(delivered?.payload.state).toBe("delivered");
    expect(delivered?.payload.computerId).toBe(computerId);
    expect(workspaceId).toBe(world.app.workspaceId);
    expect(sessionId).not.toBe("");
    expect(streaming?.done).toBe(true);
    return { sessionId, workspaceId };
  });

  await step("after: her agent stops the task by its session id and the desktop stops it", async () => {
    const stop = await answered(await sarah("stop", { sessionId: task.sessionId }));
    const stopped = !stop.isError && stop.payload.stopped === true;
    const cut = stopped
      ? await observe("the model's reply is cut off", 30_000, 1_000,
        () => world.model.agentReplyState(STOP_TURN), (reply) => reply.aborted)
      : null;
    const settled = stopped
      ? await observe("the session is no longer running", 60_000, 2_000,
        async () => answered(await sarah("read", { sessionId: task.sessionId })), (read) => !read.isError && read.payload.status !== "running")
      : null;
    const cutModel = stopped ? await turnModel(STOP_TURN) : null;
    const reportedError = settled?.last?.payload.lastError;
    const lastError = isRecord(reportedError) ? text(reportedError.message) : "";
    evidence.recordAssertionEvidence(
      "Sarah's stop reaches her desktop and stops the running task",
      stopped
        ? `remote-session:stop {sessionId} → stopped, answered by the desktop (request ${text(stop.payload.requestId)}); `
          + `the model's ${cutModel ?? "unknown"} reply was ${cut?.done ? `cut off at ${cut.last?.deliveredChunks ?? 0} of ${cut.last?.totalChunks ?? 0} chunks` : "not cut off within 30 s"}; `
          + `remote-session:read {sessionId} → ${settled?.done ? `status ${text(settled.last?.payload.status)}${lastError ? ` (${lastError})` : ""}` : "still running after 60 s"}`
        : `remote-session:stop {sessionId} → ${outcome(stop)}`,
      stopped && cut?.done === true && settled?.done === true,
    );
    expect(stop.isError, outcome(stop)).toBe(false);
    expect(stop.payload.stopped).toBe(true);
    expect(cut?.done).toBe(true);
    expect(settled?.done).toBe(true);
  });

  await step("after: a follow-up that names no model stays on the model the previous follow-up chose", async () => {
    const switched = await answered(await sarah("send", {
      sessionId: task.sessionId,
      prompt: `${SWITCH_TURN} Answer this on the switched model.`,
      model: { providerId: world.providerId, modelId: SWITCHED_MODEL },
    }));
    const switchedModel = switched.payload.state === "accepted" ? await turnModel(SWITCH_TURN) : null;
    const switchedDone = switchedModel ? await finished(task.sessionId, SWITCH_REPLY) : null;
    // A turn sent without a model used to fall back to this workspace default.
    const fallback = defaultModelId((await probe.desktopApi(defaultModelPath(task.workspaceId))).body);
    const kept = switchedDone?.done
      ? await answered(await sarah("send", { sessionId: task.sessionId, prompt: `${KEEP_TURN} Carry on from there.` }))
      : null;
    const keptModel = kept?.payload.state === "accepted" ? await turnModel(KEEP_TURN) : null;
    const keptDone = keptModel ? await finished(task.sessionId, KEEP_REPLY) : null;
    evidence.recordAssertionEvidence(
      "A follow-up without a model keeps the model the session was switched to",
      `new chats in the workspace start on ${fallback ?? "no model"}; `
        + `remote-session:send naming ${SWITCHED_MODEL} → ${outcome(switched)}, the model was asked with ${switchedModel ?? "nothing"}; `
        + `remote-session:send naming no model → ${kept ? outcome(kept) : "not sent"}, the model was asked with ${keptModel ?? "nothing"}`,
      switchedModel === SWITCHED_MODEL && keptModel === SWITCHED_MODEL && fallback !== null && fallback !== SWITCHED_MODEL && keptDone?.done === true,
    );
    expect(switched.isError, outcome(switched)).toBe(false);
    expect(switchedModel).toBe(SWITCHED_MODEL);
    expect(switchedDone?.done).toBe(true);
    // The witness: without the fix this turn would run on the workspace default instead.
    expect(fallback).not.toBeNull();
    expect(fallback).not.toBe(SWITCHED_MODEL);
    expect(kept?.isError, kept ? outcome(kept) : "not sent").toBe(false);
    expect(keptModel).toBe(SWITCHED_MODEL);
    expect(keptDone?.done).toBe(true);
  });

  await step("a teammate holding the session id can neither read, follow up on, nor stop the task", async () => {
    const before = await answered(await sarah("read", { sessionId: task.sessionId }));
    const attempts = [
      await theo("read", { sessionId: task.sessionId }),
      await theo("send", { sessionId: task.sessionId, prompt: `${TEAMMATE_TURN} What is Sarah working on?` }),
      await theo("stop", { sessionId: task.sessionId }),
    ];
    const after = await answered(await sarah("read", { sessionId: task.sessionId }));
    const leaked = await world.model.agentRequests({ promptMarker: TEAMMATE_TURN });
    const refused = attempts.every((attempt) => attempt.isError && attempt.payload.requestId === undefined && attempt.payload.target !== "desktop");
    const untouched = !before.isError && !after.isError
      && after.payload.messageCount === before.payload.messageCount
      && !JSON.stringify(after.payload.messages ?? []).includes(TEAMMATE_TURN);
    evidence.recordAssertionEvidence(
      "A teammate cannot control Sarah's desktop session",
      `Theo with Sarah's session id: ${attempts.map((attempt) => `${attempt.action} → ${attempt.isError ? text(attempt.payload.error) || "error" : outcome(attempt)}`).join(", ")}; `
        + `${attempts.some((attempt) => attempt.payload.requestId !== undefined) ? "a request was queued for a desktop" : "nothing was queued for a desktop"}. `
        + `Sarah's session: ${String(before.payload.messageCount)} → ${String(after.payload.messageCount)} messages, `
        + `${JSON.stringify(after.payload.messages ?? []).includes(TEAMMATE_TURN) ? "including Theo's follow-up" : "none from Theo"}; the model was asked ${leaked.length} times with Theo's follow-up`,
      refused && untouched && leaked.length === 0,
    );
    for (const attempt of attempts) {
      expect(attempt.isError, `${attempt.action}: ${outcome(attempt)}`).toBe(true);
      expect(attempt.payload.requestId).toBeUndefined();
      expect(attempt.payload.target).not.toBe("desktop");
    }
    expect(before.isError, outcome(before)).toBe(false);
    expect(after.isError, outcome(after)).toBe(false);
    expect(after.payload.messageCount).toBe(before.payload.messageCount);
    expect(JSON.stringify(after.payload.messages ?? [])).not.toContain(TEAMMATE_TURN);
    expect(leaked).toEqual([]);
  });
});
