import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  connectionActionMcpApp,
  connectionActionPrompt,
  connectionActionQuestion,
  connectionActionSkipPrompt,
  connectionStatusPrompt,
  connectionStatusSkipPrompt,
  connectionUsefulWork,
  isRecord,
  ordinaryDiscoveryPrompt,
  ordinaryDiscoveryReply,
} from "../worlds/library.ts";

const test = spec.world(connectionActionMcpApp, {
  timeout: 600_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "Authenticate uses the desktop OAuth callback and native connection host." },
});
const connectionUri = "ui://openwork/connection-action/v2/view.html";
const cardSelector = '[data-message-role="assistant"] [data-testid="desktop-connection-card"]';

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

/** Read native Code Mode/MCP envelopes without importing the desktop adapter. */
function payload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`Missing JSON result: ${value}`);
    return payload(JSON.parse(value.slice(start, end + 1)));
  }
  const result = record(value);
  if (Array.isArray(result.matches) || typeof result.connectionId === "string") return result;
  for (const key of ["structuredContent", "result", "output"]) {
    if (result[key] !== undefined) return payload(result[key]);
  }
  if (Array.isArray(result.content)) return payload(rows(result.content).map(part => part.text).join("\n"));
  throw new Error(`Missing connection or discovery result: ${JSON.stringify(result)}`);
}

function toolPayload(part: Record<string, unknown>) {
  const state = record(part.state);
  expect(state.status).toBe("completed");
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const result = metadata.openworkMcpResult ?? metadata.openworkMcpApp;
  if (isRecord(result)) {
    expect(result.isError).not.toBe(true);
    return payload(result);
  }
  return payload(state.output ?? state.result ?? { content: state.content });
}

function turnMessages(messages: Record<string, unknown>[], prompt: string) {
  const start = messages.findLastIndex(message => record(message.info).role === "user"
    && rows(message.parts).some(part => part.type === "text" && part.text === prompt));
  expect(start, "The exact user task must exist in the engine transcript").toBeGreaterThanOrEqual(0);
  return messages.slice(start + 1);
}

function turnTools(messages: Record<string, unknown>[], prompt: string) {
  return turnMessages(messages, prompt).flatMap(message => rows(message.parts)).filter(part => part.type === "tool");
}

function assistantText(messages: Record<string, unknown>[], prompt: string) {
  return turnMessages(messages, prompt).filter(message => record(message.info).role === "assistant")
    .flatMap(message => rows(message.parts)).filter(part => part.type === "text" && typeof part.text === "string" && part.text.trim())
    .map(part => part.text);
}

const journeys = [
  { prompt: connectionActionPrompt, choice: "Authenticate", tools: ["search_capabilities"], source: "a connection request" },
  { prompt: connectionActionSkipPrompt, choice: "Skip", tools: ["search_capabilities"], source: "a connection request" },
  { prompt: connectionStatusPrompt, choice: "Authenticate", tools: ["search_capabilities", "execute_capability"], source: "a sign-in check" },
  { prompt: connectionStatusSkipPrompt, choice: "Skip", tools: ["search_capabilities", "execute_capability"], source: "a sign-in check" },
];

test("a member chooses Authenticate or Skip and continues the same task", async ({ world, agent, user, probe, evidence, step }) => {
  const v2 = world.engine === "v2";
  const connector = world.den.mocks.connector;
  // Observe v2's real forms and context, not the legacy compatibility routes.
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  let sessionId = world.session.sessionId;
  const read = async (path: string) => {
    const response = await probe.desktopApi(`${mount}${path}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return v2 ? record(response.body).data : response.body;
  };
  const messages = async () => {
    const transcript = rows(await read(`/session/${encodeURIComponent(sessionId)}/${v2 ? "context" : "message"}`));
    if (!v2) return transcript;
    // Normalize only the observation shape; no application parsing participates
    // in the witness of which actual call owns the pending decision.
    return transcript.map(message => ({
      info: { ...message, role: message.type },
      parts: Array.isArray(message.content) ? rows(message.content).map(part => part.type === "tool"
        ? { ...part, tool: part.name, callID: part.id, messageID: message.id } : part)
        : [{ type: "text", text: message.text }],
    }));
  };
  const pending = async () => rows(await read(v2 ? "/form/request" : "/question"))
    .filter(request => request.sessionID === sessionId);
  const modelCalls = (prompt: string) => world.modelRequests(prompt);
  const nativeCard = async () => ({
    count: (await probe.dom(cardSelector)).elements.length,
    line: (await probe.dom(`${cardSelector} [role="status"], ${cardSelector} [role="alert"]`)).elements.map(element => element.text),
    buttons: (await probe.dom(`${cardSelector} button`)).elements.map(element => element.text).filter(Boolean),
  });
  const oauthRequests = async () => (await connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token");
  const noInternalNarration = async () => {
    for (const text of ["Checking connection request", "Checking connection support", "Checking whether this client supports", "question tool is available", "Task interrupted", "MessageAbortedError", "Turn stopped. Nothing retried."]) {
      await user.notSee({ text });
    }
  };
  let requestId = 0;
  async function gateway(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(`${world.den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${world.appHostSession.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const line = raw.split("\n").find(value => value.startsWith("data:"));
    return record(JSON.parse(line ? line.slice(5) : raw));
  }

  await step("before: only the current sign-in experience is available", async () => {
    await user.see("composer", { editable: true });
    if (v2) {
      const runtime = await probe.desktopApi("/experimental/engine-v2-preview/status");
      expect(runtime.body).toMatchObject({ running: true, chatRouting: true });
    }
    const tools = rows(record((await gateway("tools/list")).result).tools);
    expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "execute_capability" })]));
    const connectionTools = tools.filter(tool => {
      const metadata = isRecord(tool._meta) ? tool._meta : {};
      return isRecord(metadata.ui) && metadata.ui.resourceUri === connectionUri;
    });
    expect(connectionTools.map(tool => tool.name).sort()).toEqual(["connection_action", "connection_action_intent"]);
    const resources = rows(record((await gateway("resources/list")).result).resources);
    expect(resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: connectionUri })]));
    const legacyUri = "ui://openwork/connection-action/v1/view.html";
    expect(resources).not.toEqual(expect.arrayContaining([expect.objectContaining({ uri: legacyUri })]));
    const retired = await gateway("resources/read", { uri: legacyUri });
    expect(retired.error).toBeDefined();
    expect(retired.result).toBeUndefined();
    evidence.recordAssertionEvidence("The current sign-in experience is available", `The retired App resource is refused; this journey runs the ${world.engine} engine${v2 ? " with native chat routing" : " with its separate legacy question fixture"}.`, true);
  });

  await step("browsing available work does not ask the member to sign in", async () => {
    await user.type("composer", ordinaryDiscoveryPrompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
    for (const testId of ["connection-decision-panel", "desktop-connection-card", "connector-catalog"]) await user.notSee({ testId });
    expect((await probe.dom(`[data-mcp-app-resource="${connectionUri}"]`)).elements).toEqual([]);
    expect(await pending()).toEqual([]);
    const tools = turnTools(await messages(), ordinaryDiscoveryPrompt);
    expect(tools).toHaveLength(1);
    const result = toolPayload(tools[0]);
    expect(result.connectionAction).toBeUndefined();
    expect(result.connectionDecision).toBeUndefined();
    expect(result.connectorCatalog).toBeUndefined();
    expect(rows(result.matches)).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "connection_status", connectionStatus: expect.objectContaining({ connectionId: world.connection.id, state: "needs_connection" }),
    })]));
    expect(await oauthRequests()).toEqual([]);
    expect(await connector.toolCalls()).toEqual([]);
    const calls = await modelCalls(ordinaryDiscoveryPrompt);
    expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
    expect(calls.filter(call => call.kind === "final")).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("Browsing stays informational", "One discovery call finished with no sign-in card, pending decision, OAuth request, or provider write.", true);
  });

  const expectedConnection = { connectionId: world.connection.id, connectionName: "Notion", state: "needs_connection", actor: "member", action: { type: "connect", surface: "openwork_your_connections" } };

  for (const [index, entry] of journeys.entries()) {
    if (index > 0) sessionId = await agent.createSession(`Connection decision ${index + 1}`);
    let statusName = "";
    const oauthBefore = await oauthRequests();
    const expectedTools = v2 ? entry.tools.map(() => "execute") : [...entry.tools, "question"];
    const settledLine = entry.choice === "Skip" ? "Skipped Notion" : "Notion connected";
    const outcome = entry.choice === "Skip" ? "skipped" : "connected";

    await step(`after: ${entry.source} waits for ${entry.choice}${v2 ? " without replacing the work already done" : " in the connection card"}`, async () => {
      for (const id of [world.connection.id, world.organizationId, world.workspace.workspaceId, sessionId]) expect(entry.prompt).not.toContain(id);
      await user.type("composer", entry.prompt, { replace: true, verify: true });
      await user.click({ role: "button", label: "Run task" });
      const requests = await probe.eventually(pending, {
        within: 120_000, label: "The original task waits for the member's connection decision", until: requests => requests.length === 1,
      }).catch(async error => {
        await user.screenshot();
        evidence.recordAssertionEvidence("The sign-in choice appears", JSON.stringify({ calls: await modelCalls(entry.prompt), pending: await pending(), transcript: await messages() }), false);
        throw error;
      });
      await user.see({ role: "button", label: "Authenticate" }, { timeoutMs: 30_000 });
      await user.see({ role: "button", label: "Skip" });
      const card = await nativeCard();
      expect(card).toEqual({ count: 1, line: ["Connect Notion to continue"], buttons: ["Skip", "Authenticate"] });
      expect((await probe.dom(`[data-mcp-app-resource="${connectionUri}"]`)).elements, "The connection card is not an iframe").toEqual([]);
      for (const testId of ["connection-decision-panel", "question-panel"]) await user.notSee({ testId });
      for (const text of ["Connect this account to continue.", "Continue without this connection."]) await user.notSee({ text });
      await noInternalNarration();
      expect((await probe.dom("button")).elements.filter(element => element.text === "Authenticate")).toHaveLength(1);
      const transcript = await messages();
      const tools = turnTools(transcript, entry.prompt);
      const calls = await modelCalls(entry.prompt);
      expect(tools).toHaveLength(expectedTools.length);
      expect(calls.filter(call => call.kind === "tool")).toHaveLength(expectedTools.length);
      for (const [position, name] of expectedTools.entries()) {
        expect(tools[position]?.tool).toMatch(new RegExp(`${name}$`));
        expect(calls.filter(call => call.kind === "tool")[position]?.toolName).toMatch(new RegExp(`${name}$`));
      }
      if (v2) {
        // The native form belongs to the actual still-running outer Code Mode
        // call. No question/context call was ever requested from the model.
        const blocked = tools.at(-1);
        if (!blocked) throw new Error("Missing blocked connection call");
        expect(record(blocked.state).status).toBe("running");
        expect(blocked.messageID).toEqual(expect.any(String));
        expect(blocked.callID).toEqual(expect.any(String));
        expect(requests[0]?.metadata).toMatchObject({
          kind: "question", tool: { messageID: blocked.messageID, id: blocked.callID },
          openworkConnectionDecision: { connection: expectedConnection },
        });
        const owner = transcript.find(message => record(message.info).id === tools[0]?.messageID);
        const parts = rows(record(owner).parts);
        const prose = parts.findIndex(part => part.type === "text" && part.text === connectionUsefulWork);
        expect(prose, "Useful prose was emitted before any connection tool").toBeGreaterThanOrEqual(0);
        expect(prose).toBeLessThan(parts.findIndex(part => part.type === "tool"));
        await user.see({ text: connectionUsefulWork });
        expect(assistantText(transcript, entry.prompt), "Only useful work, never support-check narration, precedes the decision").toEqual([connectionUsefulWork]);
        expect(calls.filter(call => call.kind === "tool").map(call => call.completedTools)).toEqual(entry.tools.map((_, position) => position));
        expect(calls.some(call => /question|context/.test(String(call.toolName)))).toBe(false);
        const fields = rows(requests[0]?.fields);
        expect(JSON.stringify(fields)).toContain("Authenticate");
        expect(JSON.stringify(fields)).toContain("Skip");
      } else {
        const { custom, ...question } = connectionActionQuestion;
        expect(custom).toBe(false);
        expect(requests[0]?.questions).toEqual([expect.objectContaining(question)]);
      }
      // An ordinary search may finish before a status call, but an explicit
      // connection search itself must stay running until the member decides.
      if (!v2 || entry.tools.length === 2) {
        const found = toolPayload(tools[0]);
        const match = rows(found.matches).find(match => match.kind === "connection_status"
          && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
        if (!match || typeof match.name !== "string") throw new Error("Discovery did not return an exact status capability");
        statusName = match.name;
        if (entry.tools.length === 2) {
          expect(found.connectionAction).toBeUndefined();
          expect(match.connectionStatus).toMatchObject(expectedConnection);
          const execution = record(calls.filter(call => call.kind === "tool")[1]?.arguments);
          if (v2) expect(execution.code).toBe(`return await tools["openwork-cloud"].execute_capability(${JSON.stringify({ name: statusName })});`);
          else {
            expect(execution).toEqual({ name: statusName });
            expect(toolPayload(tools[1])).toMatchObject(expectedConnection);
          }
        } else expect(found.connectionAction).toMatchObject(expectedConnection);
      }
      const quietUntil = Date.now() + 3_000;
      await probe.eventually(async () => {
        expect(await pending()).toEqual(requests);
        expect(await modelCalls(entry.prompt), "No next model request of any kind may receive the blocked result").toEqual(calls);
        expect(calls.filter(call => call.kind === "final" || call.kind === "error")).toEqual([]);
        expect(await oauthRequests()).toEqual(oauthBefore);
        expect(await connector.toolCalls()).toEqual([]);
        return Date.now() >= quietUntil;
      }, { within: 10_000, label: "The member's decision, not a delayed model reply, releases the task", until: Boolean });
      await user.screenshot();
      evidence.recordAssertionEvidence("The member decides before the assistant continues", `${world.engine}: ${expectedTools.length} model tool request(s), one pending card, zero further model requests for 3 seconds, zero OAuth/provider writes${v2 ? ", and the earlier dashboard outline is still visible" : "; legacy question fixture only"}.`, true);
    });

    const usersBefore = (await messages()).filter(message => record(message.info).role === "user");
    const callsBefore = (await modelCalls(entry.prompt)).filter(call => call.kind === "tool");
    await step(`after: ${entry.choice} settles the card and continues the original task once`, async () => {
      const clickedAt = new Date().toISOString();
      await user.click({ role: "button", label: entry.choice });
      if (entry.choice === "Authenticate") {
        const authorization = await connector.authorizeRequestSince(clickedAt, { timeoutMs: 60_000 });
        expect(authorization.path).toBe("/authorize");
        expect(authorization.params.get("state")).toBeTruthy();
      }
      await user.see({ text: settledLine }, { timeoutMs: 120_000 });
      await user.notSee({ role: "button", label: "Authenticate" });
      await user.notSee({ role: "button", label: "Skip" });
      const continued = await probe.eventually(async () => ({ transcript: await messages(), calls: await modelCalls(entry.prompt) }), {
        within: 30_000, label: "The original turn continues from the actual settled decision",
        until: result => result.calls.some(call => call.kind === "final")
          && turnTools(result.transcript, entry.prompt).every(part => record(part.state).status === "completed"),
      });
      const completed = turnTools(continued.transcript, entry.prompt);
      let result: Record<string, unknown>;
      let finalText: string;
      if (v2) {
        result = toolPayload(completed[entry.tools.length - 1]);
        expect(result.connectionDecision).toEqual(outcome === "connected"
          ? { outcome, continuation: "review_remaining_work", repeatCompletedWrites: false }
          : { outcome, continuation: "without_connection", alternativeAuthorization: false });
        expect(record(record(completed[entry.tools.length - 1].state).metadata).openworkConnectionDecision)
          .toMatchObject({ connection: expectedConnection, outcome });
        const final = continued.calls.find(call => call.kind === "final");
        expect(record(final?.toolResultCodes).connectionResult, "The model receives the original result plus the real decision").toEqual(result);
        const found = toolPayload(completed[0]);
        const match = rows(found.matches).find(match => match.kind === "connection_status"
          && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
        if (!match || typeof match.name !== "string") throw new Error("The original discovery result was lost after the decision");
        statusName = match.name;
        if (entry.tools.length === 1) expect(found.connectionAction).toMatchObject(expectedConnection);
        else expect(result).toMatchObject(expectedConnection);
        finalText = outcome === "connected" ? "Notion is connected. The dashboard outline is ready." : "Notion setup was skipped. The dashboard outline is ready.";
        await user.see({ text: connectionUsefulWork });
      } else {
        const question = completed.find(part => part.tool === "question");
        const output = record(record(question).state).output;
        if (typeof output !== "string") throw new Error("Missing completed legacy question result");
        expect(output).toContain(entry.choice);
        finalText = output;
        result = { questionOutput: output };
      }
      await user.see({ text: finalText }, { timeoutMs: 30_000 });
      if (v2) expect(assistantText(await messages(), entry.prompt)).toEqual([connectionUsefulWork, finalText]);
      expect(continued.calls.filter(call => call.kind === "final")).toEqual([expect.objectContaining({ completedTools: expectedTools.length })]);
      expect(continued.calls.filter(call => call.kind === "tool")).toEqual(callsBefore);
      expect(continued.calls.filter(call => call.kind === "error")).toEqual([]);
      expect(continued.transcript.filter(message => record(message.info).role === "user")).toEqual(usersBefore);
      expect(completed).toHaveLength(expectedTools.length);
      expect(await pending()).toEqual([]);
      await noInternalNarration();
      await user.notSee({ text: "No connection outcome was observed." });
      expect(await nativeCard()).toEqual({ count: 1, line: [settledLine], buttons: [] });
      expect((await probe.dom(`[data-mcp-app-resource="${connectionUri}"]`)).elements).toEqual([]);
      const status = record((await gateway("tools/call", { name: "execute_capability", arguments: { name: statusName } })).result);
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ connectionId: world.connection.id, state: outcome === "connected" ? "connected" : "needs_connection" });
      const oauth = (await oauthRequests()).slice(oauthBefore.length);
      if (entry.choice === "Skip") expect(oauth).toEqual([]);
      else {
        expect(oauth.filter(request => request.path === "/authorize")).toHaveLength(1);
        expect(oauth.filter(request => request.path === "/token" && request.grantType === "authorization_code")).toEqual([expect.objectContaining({ status: 200 })]);
      }
      expect(await connector.toolCalls(), "Settling a connection never replays provider writes").toEqual([]);
      await user.screenshot();
      evidence.recordAssertionEvidence("The same task continues with the real choice", JSON.stringify({ engine: world.engine, choice: entry.choice, result, finalText, userMessages: usersBefore.length, finalReplies: 1, authorizationRequests: oauth.filter(request => request.path === "/authorize").length, providerWrites: 0 }), true);
    });

    if (entry.choice === "Authenticate") await step("revoked access does not inherit the earlier connected result", async () => {
      await user.see({ text: settledLine });
      // External provider fault, not a replacement for a person's sign-in action.
      await connector.resetOAuth();
      const rejected = await probe.api(world.den.admin, `/v1/mcp-connections/${encodeURIComponent(world.connection.id)}/tools`);
      expect(rejected.response.status).toBe(502);
      expect(rejected.body).toMatchObject({ error: "tool_catalog_failed", diagnostic: { httpStatus: 400 } });
      const status = record((await gateway("tools/call", { name: "execute_capability", arguments: { name: statusName } })).result);
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject(expectedConnection);
      expect((await oauthRequests()).slice(oauthBefore.length).filter(request => request.path === "/authorize")).toHaveLength(1);
      expect((await modelCalls(entry.prompt)).filter(call => call.kind === "tool")).toEqual(callsBefore);
      expect(await pending()).toEqual([]);
      expect(await connector.toolCalls()).toEqual([]);
      evidence.recordAssertionEvidence("Revocation does not reuse the earlier success", "The observed connection needs sign-in after refresh is rejected; no repeated authorization, model tool, provider write, or pending decision.", true);
    });
  }
});
