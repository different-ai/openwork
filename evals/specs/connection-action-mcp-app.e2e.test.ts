import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  connectionActionMcpApp,
  connectionActionPrompt,
  connectionActionQuestion,
  connectionActionSkipPrompt,
  connectionStatusPrompt,
  connectionStatusSkipPrompt,
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

const journeys = [
  { prompt: connectionActionPrompt, choice: "Authenticate", tools: ["search_capabilities"] },
  { prompt: connectionActionSkipPrompt, choice: "Skip", tools: ["search_capabilities"] },
  { prompt: connectionStatusPrompt, choice: "Authenticate", tools: ["search_capabilities", "execute_capability"] },
  { prompt: connectionStatusSkipPrompt, choice: "Skip", tools: ["search_capabilities", "execute_capability"] },
];

test("a member can Authenticate or Skip in the native connection card and continue the original task", async ({ world, agent, user, probe, evidence, step }) => {
  const connector = world.den.mocks.connector;
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
  let sessionId = world.session.sessionId;
  const sessionPath = () => `${mount}/session/${encodeURIComponent(sessionId)}`;
  const messages = async () => {
      const response = await probe.desktopApi(`${sessionPath()}/message`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return rows(response.body);
    };
    const pending = async () => {
      const response = await probe.desktopApi(`${mount}/question`);
      expect(response.status).toBe(200);
      return rows(response.body).filter(request => request.sessionID === sessionId);
    };
    const modelCalls = (prompt: string) => connector.agentRequests({ promptMarker: prompt });
    /** The native card in the transcript: its state line and its verb buttons, read from the outer document (no iframe). */
    const nativeCard = async () => {
      const cards = (await probe.dom(cardSelector)).elements;
      const line = (await probe.dom(`${cardSelector} [role="status"], ${cardSelector} [role="alert"]`)).elements.map(element => element.text);
      const buttons = (await probe.dom(`${cardSelector} button`)).elements.map(element => element.text).filter(Boolean);
      return { count: cards.length, line, buttons };
    };
    const oauthRequests = async () => (await connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token");
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

    await step("the host advertises only the v2 connection App and rejects the retired resource", async () => {
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
      evidence.recordAssertionEvidence("Standard v2 resource only", "tools/list and resources/list advertise v2; resources/read refuses v1.", true);
    });

    await step("ordinary discovery stays informational without authorization or an App", async () => {
      await user.type("composer", ordinaryDiscoveryPrompt, { verify: true });
      await user.press("Enter");
      await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
      for (const testId of ["connection-decision-panel", "desktop-connection-card", "connector-catalog"]) await user.notSee({ testId });
      expect((await probe.dom(`[data-mcp-app-resource="${connectionUri}"]`)).elements).toEqual([]);
      expect(await pending()).toEqual([]);
      const tools = turnTools(await messages(), ordinaryDiscoveryPrompt);
      expect(tools).toHaveLength(1);
      const payload = toolPayload(tools[0]);
      expect(payload.connectionAction).toBeUndefined();
      expect(payload.connectorCatalog).toBeUndefined();
      expect(rows(payload.matches)).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "connection_status", connectionStatus: expect.objectContaining({ connectionId: world.connection.id, state: "needs_connection" }),
      })]));
      expect(await oauthRequests()).toEqual([]);
      expect(await connector.toolCalls()).toEqual([]);
      await user.screenshot();
    });

    const expectedConnection = { connectionId: world.connection.id, connectionName: "Notion", state: "needs_connection", actor: "member", action: { type: "connect", surface: "openwork_your_connections" } };

    for (const [index, entry] of journeys.entries()) {
    if (index > 0) sessionId = await agent.createSession(`Connection decision ${index + 1}`);
    let statusName = "";
    const oauthBefore = await oauthRequests();
    await step(`after ${entry.tools.join(" then ")}, ${entry.choice} waits in the native card without the composer question or an iframe`, async () => {
      for (const id of [world.connection.id, world.organizationId, world.workspace.workspaceId, sessionId]) expect(entry.prompt).not.toContain(id);
      await user.type("composer", entry.prompt, { replace: true, verify: true });
      await user.click({ role: "button", label: "Run task" });
      await probe.eventually(messages, {
        within: 30_000,
        label: "The connection request appears in the conversation",
        until: transcript => transcript.some(message => record(message.info).role === "user"
          && rows(message.parts).some(part => part.type === "text" && part.text === entry.prompt)),
      }).catch(async error => {
        await user.screenshot();
        evidence.recordAssertionEvidence("Connection request submission diagnostics", JSON.stringify({ screen: await probe.text(), transcript: await messages() }), false);
        throw error;
      });
      const requests = await probe.eventually(pending, {
        within: 120_000,
        label: "The hidden connection question pauses the original task",
        until: requests => requests.length === 1,
      }).catch(async error => {
        const calls = await modelCalls(entry.prompt);
        evidence.recordAssertionEvidence("Pending connection question diagnostics", JSON.stringify({ calls, questions: await pending(), transcript: await messages() }), false);
        throw error;
      });
      const { custom, ...engineQuestion } = connectionActionQuestion;
      expect(custom).toBe(false);
      expect(requests[0]?.questions).toEqual([expect.objectContaining(engineQuestion)]);
      try {
        await user.see({ role: "button", label: "Authenticate" }, { timeoutMs: 30_000 });
      } catch (error) {
        const [screen, card, appDom, questions, transcript] = await Promise.all([
          probe.text(),
          nativeCard(),
          probe.dom(`[data-mcp-app-resource="${connectionUri}"]`),
          pending(),
          messages(),
        ]);
        await user.screenshot();
        evidence.recordAssertionEvidence(
          "The native connection card renders for the pending decision",
          JSON.stringify({ screen, card, appDom, questions, transcript }),
          false,
        );
        throw error;
      }
      await user.see({ role: "button", label: "Skip" });
      const card = await nativeCard();
      expect(card.count, "Exactly one native connection card sits in the assistant turn").toBe(1);
      expect(card.line).toEqual(["Connect Notion to continue"]);
      expect(card.buttons).toEqual(["Skip", "Authenticate"]);
      expect((await probe.dom(`[data-mcp-app-resource="${connectionUri}"]`)).elements, "The connection App is not embedded as an iframe").toEqual([]);
      for (const testId of ["connection-decision-panel", "question-panel"]) await user.notSee({ testId });
      for (const text of ["Connect this account to continue.", "Continue without this connection.", "Checking connection request"]) await user.notSee({ text });
      expect((await probe.dom("button")).elements.filter(element => element.text === "Authenticate"), "Only the native card offers Authenticate").toHaveLength(1);
      expect(await pending()).toEqual(requests);
      const tools = turnTools(await messages(), entry.prompt);
      const calls = (await modelCalls(entry.prompt)).filter(call => call.kind === "tool");
      const expectedTools = [...entry.tools, "question"];
      expect(tools).toHaveLength(expectedTools.length);
      expect(calls).toHaveLength(expectedTools.length);
      for (const [index, name] of expectedTools.entries()) {
        expect(tools[index]?.tool).toMatch(new RegExp(`${name}$`));
        expect(calls[index]?.toolName).toMatch(new RegExp(`${name}$`));
      }
      const payload = toolPayload(tools[0]);
      const match = rows(payload.matches).find(match => match.kind === "connection_status"
        && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
      if (!match || typeof match.name !== "string") throw new Error("Discovery did not return an exact status capability");
      statusName = match.name;
      if (entry.tools.length === 2) {
        expect(payload.connectionAction).toBeUndefined();
        expect(match.connectionStatus).toMatchObject(expectedConnection);
        expect(calls[1]?.arguments).toEqual({ name: statusName });
        expect(toolPayload(tools[1])).toMatchObject(expectedConnection);
      } else expect(payload.connectionAction).toMatchObject(expectedConnection);
      const quietUntil = Date.now() + 3_000;
      await probe.eventually(async () => {
        expect(await pending()).toEqual(requests);
        expect((await modelCalls(entry.prompt)).filter(call => call.kind === "tool")).toEqual(calls);
        expect((await modelCalls(entry.prompt)).filter(call => call.kind === "final")).toEqual([]);
        expect(await oauthRequests()).toEqual(oauthBefore);
        expect(await connector.toolCalls()).toEqual([]);
        return Date.now() >= quietUntil;
      }, { within: 10_000, label: "The actual pending decision waits without a delayed fake success", until: Boolean });
      await user.screenshot();
    });

    const beforeDecision = await messages();
    const usersBefore = beforeDecision.filter(message => record(message.info).role === "user");
    const callsBefore = (await modelCalls(entry.prompt)).filter(call => call.kind === "tool");
    const settledLine = entry.choice === "Skip" ? "Skipped Notion" : "Notion connected";
    await step(`${entry.choice} completes in the native card and agrees with observed connection status`, async () => {
      const clickedAt = new Date().toISOString();
      await user.click({ role: "button", label: entry.choice });
      if (entry.choice === "Authenticate") {
        try {
          const authorization = await connector.authorizeRequestSince(clickedAt, { timeoutMs: 60_000 });
          expect(authorization.path).toBe("/authorize");
          expect(authorization.params.get("state")).toBeTruthy();
        } catch (error) {
          const screen = await probe.text();
          const card = await nativeCard();
          await user.screenshot();
          evidence.recordAssertionEvidence(
            "Authenticate reaches the OAuth provider",
            `No authorization request arrived. Native card: ${JSON.stringify(card)}\nVisible app text after the click:\n${screen}`,
            false,
          );
          throw error;
        }
      }
      await user.see({ text: settledLine }, { timeoutMs: 120_000 });
      await user.notSee({ role: "button", label: "Authenticate" });
      await user.notSee({ role: "button", label: "Skip" });
      expect((await nativeCard()).line).toEqual([settledLine]);
      expect((await probe.dom(`[data-mcp-app-resource="${connectionUri}"]`)).elements).toEqual([]);
      const status = record((await gateway("tools/call", { name: "execute_capability", arguments: { name: statusName } })).result);
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ connectionId: world.connection.id, state: entry.choice === "Skip" ? "needs_connection" : "connected" });
      const oauth = (await oauthRequests()).slice(oauthBefore.length);
      if (entry.choice === "Skip") expect(oauth).toEqual([]);
      else {
        expect(oauth.filter(request => request.path === "/authorize")).toHaveLength(1);
        expect(oauth.filter(request => request.path === "/token" && request.grantType === "authorization_code")).toEqual([
          expect.objectContaining({ status: 200 }),
        ]);
      }
      expect(await connector.toolCalls()).toEqual([]);
      expect(await pending()).toEqual([]);
      expect((await modelCalls(entry.prompt)).filter(call => call.kind === "tool")).toEqual(callsBefore);
      expect((await messages()).filter(message => record(message.info).role === "user")).toEqual(usersBefore);
      for (const text of ["Task interrupted", "MessageAbortedError", "Turn stopped. Nothing retried."]) await user.notSee({ text });
      await user.screenshot();
      evidence.recordAssertionEvidence("Native card decision agrees with Den", JSON.stringify({ choice: entry.choice, status: status.structuredContent, authorizationRequests: oauth.filter(request => request.path === "/authorize").length }), true);
    });

    await step("the original task stays on this turn and shows the real decision without another user message", async () => {
      await user.see({ text: settledLine });
      const continued = await probe.eventually(async () => {
        const transcript = await messages();
        const question = turnTools(transcript, entry.prompt).find(part => part.tool === "question");
        const state = question && record(question.state);
        const output = state?.status === "completed" && typeof state.output === "string" ? state.output : null;
        const final = transcript.find(message => record(message.info).role === "assistant"
          && rows(message.parts).some(part => part.type === "text" && part.text === output));
        return { transcript, output, final, calls: await modelCalls(entry.prompt) };
      }, {
        within: 30_000,
        label: "The model continues with the actual completed question result",
        until: result => Boolean(result.output && result.final && result.calls.some(call => call.kind === "final")),
      });
      expect(continued.output).toContain(entry.choice);
      expect(continued.calls.filter(call => call.kind === "final")).toEqual([
        expect.objectContaining({ completedTools: entry.tools.length + 1 }),
      ]);
      await user.see({ text: continued.output ?? "Missing question result" });
      expect(continued.transcript.filter(message => record(message.info).role === "user")).toEqual(usersBefore);
      expect(continued.calls.filter(call => call.kind === "tool")).toEqual(callsBefore);
      expect(continued.calls.filter(call => call.kind === "error")).toEqual([]);
      expect(await pending()).toEqual([]);
      await user.notSee({ text: "No connection outcome was observed." });
      await user.screenshot();
      const card = await nativeCard();
      expect(card.count).toBe(1);
      expect(card.line).toEqual([settledLine]);
      expect(card.buttons).toEqual([]);
      evidence.recordAssertionEvidence("The original task continues from the real decision", JSON.stringify({ choice: entry.choice, card, questionOutput: continued.output, finalMessage: continued.final, finalCalls: continued.calls.filter(call => call.kind === "final"), userMessages: usersBefore.length }), true);
    });

    if (entry.choice === "Authenticate") await step("revoked credentials never inherit the earlier connected result", async () => {
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
      evidence.recordAssertionEvidence("Revocation does not reuse the prior success", "Exact status returns needs_connection after refresh is rejected; no repeated authorization, model tool, or native question.", true);
    });
    }
});
