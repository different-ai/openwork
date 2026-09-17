import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionActionMcpApp, connectionActionPrompt, connectionActionQuestion, connectionActionReply, connectionActionReplySkip, connectionActionSkipPrompt, connectionStatusPrompt, connectionStatusSkipPrompt, isRecord, ordinaryDiscoveryPrompt, ordinaryDiscoveryReply } from "../worlds/library.ts";

const test = spec.world(connectionActionMcpApp, { timeout: 600_000 });

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

function toolPayload(part: Record<string, unknown>) {
  const state = record(part.state);
  expect(state.status).toBe("completed");
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const result = metadata.openworkMcpResult ?? metadata.openworkMcpApp;
  if (isRecord(result)) {
    expect(result.isError).not.toBe(true);
    if (isRecord(result.structuredContent)) return result.structuredContent;
  }
  if (typeof state.output !== "string") throw new Error("The completed tool has no output");
  return record(JSON.parse(state.output));
}

function turnTools(messages: Record<string, unknown>[], prompt: string) {
  const start = messages.findLastIndex(message => record(message.info).role === "user"
    && rows(message.parts).some(part => part.type === "text" && part.text === prompt));
  expect(start, "The exact user task must exist in the engine transcript").toBeGreaterThanOrEqual(0);
  return messages.slice(start + 1).flatMap(message => rows(message.parts)).filter(part => part.type === "tool");
}

test("ordinary discovery stays quiet without a native question or authorization", async ({ world, user, probe, evidence }) => {
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
  await user.type("composer", ordinaryDiscoveryPrompt, { verify: true });
  await user.press("Enter");
  await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
  for (const testId of ["connection-decision-panel", "desktop-connection-card", "connector-catalog"]) await user.notSee({ testId });
  await user.notSee({ role: "button", label: "Authenticate" });
  const pending = await probe.desktopApi(`${mount}/question`);
  expect(pending.status).toBe(200);
  expect(rows(pending.body).filter(request => request.sessionID === world.session.sessionId)).toEqual([]);
  const response = await probe.desktopApi(`${mount}/session/${encodeURIComponent(world.session.sessionId)}/message`);
  expect(response.status).toBe(200);
  const tools = turnTools(rows(response.body), ordinaryDiscoveryPrompt);
  expect(tools).toHaveLength(1);
  const discovery = toolPayload(tools[0]);
  expect(discovery.connectionAction).toBeUndefined();
  expect(discovery.connectorCatalog).toBeUndefined();
  expect(rows(discovery.matches)).toEqual(expect.arrayContaining([expect.objectContaining({
    kind: "connection_status", connectionStatus: expect.objectContaining({ connectionId: world.connection.id, state: "needs_connection" }),
  })]));
  const calls = (await world.den.mocks.connector.agentRequests({ promptMarker: ordinaryDiscoveryPrompt })).filter(call => call.kind === "tool");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.toolName).toMatch(/search_capabilities$/);
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token")).toEqual([]);
  await user.screenshot();
  evidence.recordAssertionEvidence("Discovery remains informational", "The actual search result has a status match but no action, native question, card, or OAuth request", true);
});

for (const entry of [
  { name: "connection search", prompt: connectionActionPrompt, skipPrompt: connectionActionSkipPrompt, tools: ["search_capabilities"] },
  { name: "connection status execution", prompt: connectionStatusPrompt, skipPrompt: connectionStatusSkipPrompt, tools: ["search_capabilities", "execute_capability"] },
]) {
  for (const choice of ["Authenticate", "Skip"]) {
    test(`desktop pauses ${entry.name} for native ${choice} and continues the same turn`, async ({ world, user, probe, evidence }) => {
      const connector = world.den.mocks.connector;
      const prompt = choice === "Skip" ? entry.skipPrompt : entry.prompt;
      const reply = choice === "Skip" ? connectionActionReplySkip : connectionActionReply;
      const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
      const sessionPath = `${mount}/session/${encodeURIComponent(world.session.sessionId)}`;
      const messages = async () => {
        const response = await probe.desktopApi(`${sessionPath}/message`);
        expect(response.status).toBe(200);
        return rows(response.body);
      };
      const pending = async () => {
        const response = await probe.desktopApi(`${mount}/question`);
        expect(response.status).toBe(200);
        return rows(response.body).filter(request => request.sessionID === world.session.sessionId);
      };
      const modelRequests = () => connector.agentRequests({ promptMarker: prompt });
      const modelTools = async () => (await modelRequests()).filter(call => call.kind === "tool");
      const oauthRequests = async () => (await connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token");
      const assertTranscriptCard = async (label: string) => {
        const cards = await probe.dom('[data-testid="desktop-connection-card"]');
        expect(cards.elements).toHaveLength(1);
        expect(cards.elements[0]?.text).toContain(label);
        expect(cards.elements[0]?.rect.width).toBeGreaterThan(0);
        expect(cards.elements[0]?.rect.height).toBeGreaterThan(0);
        expect((await probe.dom('[data-message-role="assistant"] [data-testid="desktop-connection-card"]')).elements).toHaveLength(1);
        for (const testId of ["connection-decision-panel", "question-panel"]) await user.notSee({ testId });
        await user.notSee({ text: "Connect Notion to continue?" });
        await user.notSee({ text: "Turn stopped. Nothing retried." });
        await user.notSee({ text: "MessageAbortedError" });
        await user.notSee({ text: "Used *" });
        await user.notSee({ text: "Task interrupted" });
        expect((await probe.dom('[data-mcp-app-resource="ui://openwork/connection-action/v1/view.html"]')).elements).toHaveLength(0);
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
      const tools = record((await gateway("tools/list")).result).tools;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "execute_capability" })]));
      expect(tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "connection_action" })]));
      const legacyUri = "ui://openwork/connection-action/v1/view.html";
      const resources = record((await gateway("resources/list")).result).resources;
      expect(Array.isArray(resources)).toBe(true);
      expect(resources).not.toEqual(expect.arrayContaining([expect.objectContaining({ uri: legacyUri })]));
      const retiredResource = await gateway("resources/read", { uri: legacyUri });
      expect(retiredResource.error).toBeDefined();
      expect(retiredResource.result).toBeUndefined();

      for (const id of [world.connection.id, world.organizationId, world.workspace.workspaceId, world.session.sessionId]) expect(prompt).not.toContain(id);
      await user.type("composer", prompt, { verify: true });
      await user.press("Enter");
      const requests = await probe.eventually(pending, {
        within: 120_000, label: "The actual built-in question pauses the engine", until: requests => requests.length === 1,
      });
      const request = requests[0];
      expect(request.questions).toEqual([connectionActionQuestion]);
      expect(request.tool).toMatchObject({ messageID: expect.any(String), callID: expect.any(String) });
      await user.see({ role: "button", label: "Authenticate" }, { timeoutMs: 30_000 });
      await user.see({ role: "button", label: "Skip" });
      await assertTranscriptCard("Notion");
      const pausedMessages = await messages();
      const usersAtPause = pausedMessages.filter(message => record(message.info).role === "user");
      expect(usersAtPause).toHaveLength(1);
      const pausedTools = turnTools(pausedMessages, prompt);
      const expectedTools = [...entry.tools, "openwork_context", "question"];
      const callsAtPause = await modelTools();
      expect(callsAtPause).toHaveLength(expectedTools.length);
      expect(pausedTools).toHaveLength(expectedTools.length);
      for (const [index, tool] of expectedTools.entries()) {
        expect(callsAtPause[index]?.toolName).toMatch(new RegExp(`${tool}$`));
        expect(pausedTools[index]?.tool).toMatch(new RegExp(`${tool}$`));
      }
      const question = pausedTools.at(-1);
      if (!question) throw new Error("Missing actual native question tool part");
      expect(question.tool).toBe("question");
      expect(question.callID).toBe(record(request.tool).callID);
      expect(pausedMessages.find(message => record(message.info).id === record(request.tool).messageID)?.parts).toEqual(expect.arrayContaining([question]));
      expect(record(question.state)).toMatchObject({ status: "running", input: { questions: [connectionActionQuestion] } });
       expect(record(record(toolPayload(pausedTools[entry.tools.length]).context).features).connectionQuestions).toBe(true);
      const expectedConnection = { connectionId: world.connection.id, connectionName: "Notion", state: "needs_connection", actor: "member", action: { type: "connect", surface: "openwork_your_connections" } };
      const firstPayload = toolPayload(pausedTools[0]);
      const statusMatch = rows(firstPayload.matches).find(match => match.kind === "connection_status"
        && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
      if (!statusMatch || typeof statusMatch.name !== "string") throw new Error("Discovery did not return an exact status capability");
      const statusName = statusMatch.name;
      if (entry.tools.length === 2) {
        expect(firstPayload.connectionAction).toBeUndefined();
        expect(statusMatch.connectionStatus).toMatchObject(expectedConnection);
        expect(callsAtPause[1]?.arguments).toEqual({ name: statusName });
        expect(record(pausedTools[1].state).input).toEqual({ name: statusName });
        expect(toolPayload(pausedTools[1])).toMatchObject(expectedConnection);
      } else {
        expect(firstPayload.connectionAction).toMatchObject(expectedConnection);
      }
      const quietUntil = Date.now() + 3_000;
      await probe.eventually(async () => {
        expect(await pending()).toEqual(requests);
        expect(turnTools(await messages(), prompt)).toEqual(pausedTools);
        expect(await modelTools()).toEqual(callsAtPause);
        expect((await modelRequests()).filter(call => call.kind === "final")).toEqual([]);
        expect(await oauthRequests()).toEqual([]);
        expect(await connector.toolCalls()).toEqual([]);
        return Date.now() >= quietUntil;
      }, { within: 10_000, label: "Native question stays pending without a fake final-response delay", until: Boolean });
      await user.notSee({ text: reply });
      await user.screenshot();
      evidence.recordAssertionEvidence("One trusted transcript card owns the pending native question", JSON.stringify({ request, tool: question, toolNames: callsAtPause.map(call => call.toolName) }), true);

      const clickedAt = new Date().toISOString();
      await user.click({ role: "button", label: choice });
      if (choice === "Authenticate") {
        const authorization = await connector.authorizeRequestSince(clickedAt, { timeoutMs: 60_000 });
        expect(authorization.path).toBe("/authorize");
        expect(authorization.params.get("state")).toBeTruthy();
      }
      await user.see({ text: reply }, { timeoutMs: 120_000 });
      await probe.eventually(pending, { within: 30_000, label: "The native question resolves after the user choice", until: requests => requests.length === 0 });
      const finishedMessages = await messages();
      expect(finishedMessages.filter(message => record(message.info).role === "user")).toEqual(usersAtPause);
      const finishedTools = turnTools(finishedMessages, prompt);
      expect(finishedTools).toHaveLength(pausedTools.length);
      const answered = finishedTools.at(-1);
      if (!answered) throw new Error("Missing completed native question");
      expect(answered.callID).toBe(question.callID);
      expect(record(answered.state)).toMatchObject({ status: "completed", input: { questions: [connectionActionQuestion] }, output: expect.stringContaining(choice) });
      for (const message of finishedMessages) expect(record(message.info).error).toBeUndefined();
      const final = finishedMessages.findLast(message => record(message.info).role === "assistant"
        && rows(message.parts).some(part => part.type === "text" && part.text === reply));
      if (!final) throw new Error("The original run did not persist its continuation reply");
      expect(record(final.info).parentID).toBe(record(usersAtPause[0].info).id);
      expect(record(record(final.info).time).completed).toEqual(expect.any(Number));
      expect(await modelTools()).toEqual(callsAtPause);
      expect((await modelRequests()).filter(call => call.kind === "final")).toHaveLength(1);
      expect((await modelRequests()).filter(call => call.kind === "error")).toEqual([]);
      expect(await connector.toolCalls()).toEqual([]);
      await assertTranscriptCard(choice === "Skip" ? "Skipped Notion" : "Notion connected");
      await user.notSee({ role: "button", label: "Authenticate" });
      await user.notSee({ role: "button", label: "Draft retry" });
      const oauth = await oauthRequests();
      if (choice === "Skip") {
        expect(oauth).toEqual([]);
      } else {
        expect(oauth.filter(request => request.path === "/authorize")).toHaveLength(1);
        expect(oauth.filter(request => request.path === "/token")).toEqual(expect.arrayContaining([expect.objectContaining({ status: 200, grantType: "authorization_code" })]));
      }
      await user.screenshot();
       evidence.recordAssertionEvidence(`${choice} resumes the same native run without abort or another user turn`, JSON.stringify({ questionState: answered.state, userMessages: 1, toolNames: callsAtPause.map(call => call.toolName), oauth: oauth.map(request => ({ path: request.path, status: request.status, grantType: request.grantType })) }), true);

      if (choice === "Authenticate") {
        await connector.resetOAuth();
        const rejected = await probe.api(world.den.admin, `/v1/mcp-connections/${encodeURIComponent(world.connection.id)}/tools`);
        expect(rejected.response.ok).toBe(false);
        expect(rejected.response.status).toBe(502);
        expect(rejected.body).toMatchObject({ error: "tool_catalog_failed", diagnostic: { httpStatus: 400 } });
        expect(await connector.requests()).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/token", status: 400, grantType: "refresh_token" })]));
        const reauthRpc = await gateway("tools/call", { name: "execute_capability", arguments: { name: statusName } });
        expect(reauthRpc.error).toBeUndefined();
        const reauthResult = record(reauthRpc.result);
        expect(reauthResult.isError).not.toBe(true);
        expect(reauthResult.structuredContent).toMatchObject(expectedConnection);
        expect(record(reauthResult.structuredContent).state).not.toBe("connected");
        expect((await connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(1);
        expect(await modelTools()).toEqual(callsAtPause);
        expect((await messages()).filter(message => record(message.info).role === "user")).toEqual(usersAtPause);
        expect(await pending()).toEqual([]);
        expect(await connector.toolCalls()).toEqual([]);
        evidence.recordAssertionEvidence("Successful exact status execution is not provider-health proof", "Credential revocation yields needs_connection without a model retry, new native question, or authorization", true);
      }
    });
  }
}
