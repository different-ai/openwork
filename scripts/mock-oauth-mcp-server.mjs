#!/usr/bin/env node
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3978);
const issuer = process.env.ISSUER || `http://${host}:${port}`;
const extraToolCount = Number(process.env.MOCK_EXTRA_TOOL_COUNT || 0);
const autoApprove = process.env.AUTO_APPROVE !== "0";
const disableDcr = process.env.DISABLE_DCR === "1";
const rejectDcrRedirectUris = process.env.MOCK_REJECT_DCR_REDIRECT_URIS || "";
const strictOAuth = process.argv.includes("--strict") || process.env.STRICT_OAUTH === "1";
// Strict mode rejects refresh tokens this instance did not issue (and
// rotates on every refresh grant). Off by default: eval flows restart the
// mock mid-scenario and legitimately present pre-restart refresh tokens.
let strictRefreshTokens = process.env.STRICT_REFRESH_TOKENS === "1";
const mockClientId = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const mockClientSecret = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const preregisteredRedirectUris = (process.env.MOCK_REDIRECT_URIS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// Clients whose token requests fail the way a provider rejects a client whose
// configured authentication does not match its registration. An entry is a
// client id, or "id:secret" to reject only when that exact secret is presented
// (so a request that lost the secret is observable). "@dynamic" rejects every
// client this mock registered dynamically.
const rejectedTokenClients = (process.env.MOCK_REJECT_TOKEN_CLIENT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf(":");
    return separator === -1
      ? { clientId: entry, clientSecret: null }
      : { clientId: entry.slice(0, separator), clientSecret: entry.slice(separator + 1) };
  });

function rejectsTokenClient(clientId, clientSecret) {
  return rejectedTokenClients.some((entry) => (
    (entry.clientId === "@dynamic" && clients.has(clientId))
    || (entry.clientId === clientId && (entry.clientSecret === null || entry.clientSecret === clientSecret))
  ));
}
const advertisedScopes = ["mcp:read", "mcp:write"];
const extraToolName = (process.env.MOCK_EXTRA_TOOL_NAME || "").trim();
const extraToolTitle = (process.env.MOCK_EXTRA_TOOL_TITLE || extraToolName).trim();
const extraToolDescription = (process.env.MOCK_EXTRA_TOOL_DESCRIPTION || "Returns a fixed result from the mock OAuth MCP server.").trim();
const extraToolResult = process.env.MOCK_EXTRA_TOOL_RESULT || "mock oauth mcp ok";
const errorToolName = (process.env.MOCK_ERROR_TOOL_NAME || "").trim();
const errorToolTitle = (process.env.MOCK_ERROR_TOOL_TITLE || errorToolName).trim();
const errorToolDescription = (process.env.MOCK_ERROR_TOOL_DESCRIPTION || "Returns a provider policy error from the mock OAuth MCP server.").trim();
const errorToolStatus = Number(process.env.MOCK_ERROR_TOOL_STATUS || 403);
const errorToolMode = (process.env.MOCK_ERROR_TOOL_MODE || "result").trim();
const errorToolConnectUrl = (process.env.MOCK_ERROR_TOOL_CONNECT_URL || "https://connect.example.test/salesforce/start").trim();
const errorToolProvider = (process.env.MOCK_ERROR_TOOL_PROVIDER || "salesforce").trim();
const allowUnauthenticatedMcp = process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP === "1";
// An app-visible MCP App launch tool (`_meta.ui.resourceUri`), so dashboard
// and MCP App specs can witness App catalogs without a real provider.
const appToolName = (process.env.MOCK_APP_TOOL_NAME || "").trim();
const syntheticTools = Array.from({ length: extraToolCount }, (_, index) => {
  const i = index + 1;
  return {
    name: `mock_tool_${i}`,
    description: `Synthetic scale tool ${i} for capability search volume testing; keyword kw${i}.`,
    inputSchema: { type: "object", properties: {} },
  };
});

const clients = new Map();
const codes = new Map();
const tokens = new Set();
const refreshTokens = new Set();
let holdRefreshResponses = false;
let nextRefreshResponseId = 0;
const pendingRefreshResponses = new Map();
const requests = [];
const drafts = [];
let agentWorkloads = [];
let agentRequiredHeader = null;
const agentReplyGates = new Map();
const AGENT_REPLY_GATE_TIMEOUT_MS = 60_000;
let agentRepliesHeld = false;
const heldAgentReplies = new Set();
let configuredTools = [];
let oauthCallback = {};

const gmailThreadId = "thread-q3-launch";

function gmailBodyData(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

const gmailThreadMessages = [
  {
    id: "msg-q3-kickoff",
    threadId: gmailThreadId,
    snippet: "Hi Sarah, Thursday still works for the Q3 launch prep.",
    payload: {
      headers: [
        { name: "From", value: "Jordan Demo <jordan.demo@acme.test>" },
        { name: "To", value: "Sarah Chen <sarah@acme.test>" },
        { name: "Subject", value: "Q3 launch" },
        { name: "Date", value: "Mon, 13 Jul 2026 16:30:00 -0700" },
        { name: "Message-ID", value: "<kickoff-1@acme.test>" },
      ],
      mimeType: "text/plain",
      body: {
        data: gmailBodyData([
          "Hi Sarah,",
          "Thursday still works for the Q3 launch prep.",
          "I am checking the final room details now.",
          "Jordan",
        ].join("\n")),
      },
    },
  },
  {
    id: "msg-q3-sarah-2",
    threadId: gmailThreadId,
    snippet: "Are we still on for Thursday? I need to confirm the room booking by Wednesday.",
    payload: {
      headers: [
        { name: "From", value: "Sarah Chen <sarah@acme.test>" },
        { name: "To", value: "Jordan Demo <jordan.demo@acme.test>" },
        { name: "Subject", value: "Re: Q3 launch" },
        { name: "Date", value: "Tue, 14 Jul 2026 09:15:00 -0700" },
        { name: "Message-ID", value: "<sarah-2@acme.test>" },
        { name: "References", value: "<kickoff-1@acme.test>" },
      ],
      mimeType: "text/plain",
      body: {
        data: gmailBodyData([
          "Are we still on for Thursday?",
          "I need to confirm the room booking by Wednesday.",
          "Also bringing the updated launch checklist.",
          "Sarah",
        ].join("\n")),
      },
    },
  },
];

const gmailMessagesById = new Map(gmailThreadMessages.map((message) => [message.id, message]));

function gmailMessageShape(message, format) {
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    payload: format === "full" ? message.payload : { headers: message.payload.headers },
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function agentContentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(agentContentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return agentContentText(value.content);
}

function validateAgentWorkloads(value) {
  if (!Array.isArray(value)) throw new Error("agent workloads must be an array");
  const markers = new Set();
  return value.map((workload) => {
    if (!workload || typeof workload !== "object") throw new Error("agent workload must be an object");
    const promptMarker = typeof workload.promptMarker === "string" ? workload.promptMarker.trim() : "";
    const finalReply = typeof workload.finalReply === "string" ? workload.finalReply : "";
    if (!promptMarker || !finalReply || !Array.isArray(workload.steps)) {
      throw new Error("agent workload needs promptMarker, finalReply, and a steps array");
    }
    if (markers.has(promptMarker)) throw new Error(`duplicate agent workload marker: ${promptMarker}`);
    markers.add(promptMarker);
    // Deliver the final reply as consecutive content deltas of this many
    // characters, so a spec can watch an answer render while it streams.
    const finalReplyChunkSize = workload.finalReplyChunkSize === undefined ? null : workload.finalReplyChunkSize;
    if (finalReplyChunkSize !== null && (!Number.isInteger(finalReplyChunkSize) || finalReplyChunkSize < 1)) {
      throw new Error(`agent workload ${promptMarker} finalReplyChunkSize must be a positive integer`);
    }
    const finalReplyChunks = workload.finalReplyChunks === undefined ? null : workload.finalReplyChunks;
    if (finalReplyChunks !== null && (!Array.isArray(finalReplyChunks) || finalReplyChunks.length === 0
      || finalReplyChunks.some((chunk) => typeof chunk !== "string") || finalReplyChunks.join("") !== finalReply)) {
      throw new Error(`agent workload ${promptMarker} finalReplyChunks must concatenate to finalReply`);
    }
    if (finalReplyChunks !== null && finalReplyChunkSize !== null) {
      throw new Error(`agent workload ${promptMarker} cannot set both finalReplyChunks and finalReplyChunkSize`);
    }
    const finalReplyInitiallyReleasedChunks = workload.finalReplyInitiallyReleasedChunks === undefined
      ? null : workload.finalReplyInitiallyReleasedChunks;
    if (finalReplyInitiallyReleasedChunks !== null && (finalReplyChunks === null
      || !Number.isInteger(finalReplyInitiallyReleasedChunks) || finalReplyInitiallyReleasedChunks < 1
      || finalReplyInitiallyReleasedChunks > finalReplyChunks.length || workload.finalReplyFrom !== undefined)) {
      throw new Error(`agent workload ${promptMarker} gated replies require exact static chunks and a valid initial release count`);
    }
    if (workload.finalReasoning !== undefined && typeof workload.finalReasoning !== "string") {
      throw new Error(`agent workload ${promptMarker} finalReasoning must be a string`);
    }
    if (workload.latestUserTurn !== undefined && typeof workload.latestUserTurn !== "boolean") {
      throw new Error(`agent workload ${promptMarker} latestUserTurn must be a boolean`);
    }
    if (workload.finalReplyFrom !== undefined && !["last-tool-text", "system-text"].includes(workload.finalReplyFrom)) {
      throw new Error(`agent workload ${promptMarker} has an unknown reply source`);
    }
    const steps = workload.steps.map((step) => {
      if (!step || typeof step !== "object" || typeof step.tool !== "string" || !step.tool.trim()) {
        throw new Error(`agent workload ${promptMarker} has an invalid tool step`);
      }
      if (!step.arguments || typeof step.arguments !== "object" || Array.isArray(step.arguments)) {
        throw new Error(`agent workload ${promptMarker} tool ${step.tool} needs object arguments`);
      }
      if (step.argumentsFrom !== undefined && !["computer-mention", "skill-catalog", "capability-search"].includes(step.argumentsFrom)) {
        throw new Error(`agent workload ${promptMarker} has an unknown argument source`);
      }
      if (step.allowUnadvertisedTool !== undefined && typeof step.allowUnadvertisedTool !== "boolean") {
        throw new Error(`agent workload ${promptMarker} allowUnadvertisedTool must be a boolean`);
      }
      if (step.text !== undefined && typeof step.text !== "string") {
        throw new Error(`agent workload ${promptMarker} tool text must be a string`);
      }
      return { tool: step.tool.trim(), arguments: structuredClone(step.arguments), argumentsFrom: step.argumentsFrom,
        text: step.text, allowUnadvertisedTool: step.allowUnadvertisedTool === true };
    });
    if (workload.matchAll !== undefined && typeof workload.matchAll !== "boolean")
      throw new Error(`agent workload ${promptMarker} matchAll must be a boolean`);
    const finalReplyDelayMs = workload.finalReplyDelayMs ?? 0;
    if (!Number.isInteger(finalReplyDelayMs) || finalReplyDelayMs < 0 || finalReplyDelayMs > 10000)
      throw new Error("finalReplyDelayMs must be between 0 and 10000");
    const rateLimitAttempts = workload.rateLimitAttempts ?? 0;
    if (!Number.isInteger(rateLimitAttempts) || rateLimitAttempts < 0 || rateLimitAttempts > 3)
      throw new Error("rateLimitAttempts must be between 0 and 3");
    return { promptMarker, matchAll: workload.matchAll === true, finalReply, finalReplyFrom: workload.finalReplyFrom, finalReplyChunkSize, finalReplyChunks,
      finalReplyInitiallyReleasedChunks, finalReplyDelayMs, finalReasoning: workload.finalReasoning, steps,
      latestUserTurn: workload.latestUserTurn === true, rateLimitAttempts };
  });
}

function finalReplyChunks(workload) {
  if (workload.finalReplyChunks !== null) return workload.finalReplyChunks;
  if (workload.finalReplyChunkSize === null) return [workload.finalReply];
  const chunks = [];
  for (let offset = 0; offset < workload.finalReply.length; offset += workload.finalReplyChunkSize) {
    chunks.push(workload.finalReply.slice(offset, offset + workload.finalReplyChunkSize));
  }
  return chunks;
}

function publicAgentReplyState(state) {
  return {
    promptMarker: state.promptMarker,
    releasedChunks: state.releasedChunks,
    deliveredChunks: state.deliveredChunks,
    totalChunks: state.totalChunks,
    prefix: state.prefix,
    complete: state.complete,
    waiting: state.waiters.length,
    aborted: state.aborted,
    timedOut: state.timedOut,
  };
}

function createAgentReplyGate(workload, chunks) {
  const previous = agentReplyGates.get(workload.promptMarker);
  if (previous && !previous.complete) throw new Error(`agent reply ${workload.promptMarker} already has an active stream`);
  const state = {
    promptMarker: workload.promptMarker,
    releasedChunks: workload.finalReplyInitiallyReleasedChunks,
    deliveredChunks: 0,
    totalChunks: chunks.length,
    prefix: "",
    complete: false,
    aborted: false,
    timedOut: false,
    waiters: [],
  };
  agentReplyGates.set(workload.promptMarker, state);
  return state;
}

function releaseAgentReplyWaiters(gate, released) {
  for (const waiter of gate.waiters.splice(0)) waiter(released);
}

function waitForAgentReplyRelease(gate) {
  if (gate.aborted || gate.timedOut) return Promise.resolve(false);
  if (gate.deliveredChunks < gate.releasedChunks) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (released) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = gate.waiters.indexOf(finish);
      if (index >= 0) gate.waiters.splice(index, 1);
      resolve(released);
    };
    const timer = setTimeout(() => {
      gate.timedOut = true;
      finish(false);
    }, AGENT_REPLY_GATE_TIMEOUT_MS);
    gate.waiters.push(finish);
  });
}

async function gatedAgentStream(res, model, workload, finalReply) {
  const chunks = finalReplyChunks({ ...workload, finalReply });
  const gate = createAgentReplyGate(workload, chunks);
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const abort = () => {
    if (gate.complete) return;
    gate.aborted = true;
    releaseAgentReplyWaiters(gate, false);
  };
  res.once("close", abort);
  res.write(`data: ${JSON.stringify(agentChunk(model, { role: "assistant" }))}\n\n`);
  if (workload.finalReasoning) {
    res.write(`data: ${JSON.stringify(agentChunk(model, { reasoning_content: workload.finalReasoning }))}\n\n`);
  }
  for (const content of chunks) {
    while (gate.deliveredChunks >= gate.releasedChunks) {
      if (!await waitForAgentReplyRelease(gate)) {
        if (!res.destroyed) res.destroy();
        return;
      }
    }
    if (gate.aborted || gate.timedOut || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(agentChunk(model, { content }))}\n\n`);
    gate.deliveredChunks += 1;
    gate.prefix += content;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (gate.aborted || gate.timedOut || res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(agentChunk(model, {}, "stop"))}\n\n`);
  gate.complete = true;
  res.off("close", abort);
  res.end("data: [DONE]\n\n");
}

function offeredAgentTool(body, wanted) {
  if (!Array.isArray(body?.tools)) return null;
  const names = body.tools.flatMap((tool) => (
    tool && typeof tool === "object" && typeof tool.function?.name === "string"
      ? [tool.function.name]
      : []
  ));
  return names.find((name) => name === wanted)
    ?? names.find((name) => name.endsWith(`_${wanted}`))
    ?? null;
}

function skillCatalogArguments(messages, skillName) {
  // The pinned AI SDK path preserves chronological instruction updates as
  // XML-escaped system-update blocks. Ordinary user text is not discovery.
  const system = messages.flatMap((message) => {
    const text = agentContentText(message);
    if (message.role === "system") return [text];
    const update = message.role === "user" ? text.match(/^<system-update>\n([\s\S]*)\n<\/system-update>$/) : null;
    return update ? [update[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")] : [];
  }).join("\n");
  if (!system.includes("You are OpenWork.")) throw new Error("The model did not receive OpenWork operating instructions");
  // Replay the native catalog protocol in order: initial snapshots, additions,
  // replacement snapshots, and removals. Historical entries are not current.
  const catalog = new Map();
  for (const update of system.split(/(?=<available_skills>|The available skills have changed|New skills are available|The following skill IDs|Skill guidance is no longer available|No skills are currently available)/)) {
    if (update.startsWith("<available_skills>") || update.startsWith("The available skills have changed")
      || update.startsWith("Skill guidance is no longer available") || update.startsWith("No skills are currently available")) catalog.clear();
    for (const [, entry] of update.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
      const id = entry.match(/<id>([^<]+)<\/id>/)?.[1];
      const name = entry.match(/<name>([^<]+)<\/name>/)?.[1];
      if (id && name) catalog.set(id, name);
    }
    const removed = update.match(/The following skill IDs are no longer available and must not be used: ([^\n]+)\./)?.[1];
    for (const id of removed?.split(", ") ?? []) catalog.delete(id);
  }
  const id = [...catalog].find(([, name]) => name === skillName)?.[0];
  return id ? { id } : null;

}

function agentStream(res, model, chunks, hold = false) {
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = () => {
    heldAgentReplies.delete(send);
    if (res.destroyed) return;
    let delayMs = 150;
    for (const chunk of hold ? chunks.slice(1) : chunks) {
      setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }, delayMs);
      delayMs += 150;
    }
    setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
    }, delayMs);
  };
  if (hold) {
    res.write(`data: ${JSON.stringify(chunks[0])}\n\n`);
    heldAgentReplies.add(send);
    res.once("close", () => heldAgentReplies.delete(send));
  } else {
    send();
  }
}

function agentChunk(model, delta, finishReason = null) {
  return {
    id: `chatcmpl-mock-agent-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// A deterministic model that reads the submitted message, rather than replaying
// an expected destination or task from the fixture.
function computerMentionArguments(messages) {
  const message = [...messages].reverse().find((candidate) => candidate?.role === "user"
    && agentContentText(candidate).includes("[The user selected @"));
  const text = agentContentText(message);
  const instruction = text.match(/\[The user selected @(?:cloud|desktop):[\s\S]*?\]/)?.[0];
  const target = instruction?.match(/execute it with target "(cloud|desktop)"/)?.[1];
  if (!instruction || !target) throw new Error("computer task has no routing instruction");
  const prompt = text.replace(instruction, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/(^|\s)@(cloud|desktop)(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ").trim();
  if (!prompt) throw new Error("computer task has no prompt");
  return { name: "remote-session:create", body: { target, prompt } };
}

// Resolve execution from the result the engine actually returned to the model.
function lastToolText(messages) {
  const message = [...messages].reverse().find((message) => message?.role === "tool");
  const text = agentContentText(message);
  if (!text) throw new Error("the model received no tool result");
  return text;
}

function capabilitySearchArguments(messages) {
  let payload = JSON.parse(lastToolText(messages));
  if (Array.isArray(payload.content)) payload = JSON.parse(agentContentText(payload));
  const matches = payload.matches;
  if (!Array.isArray(matches) || matches.length !== 1 || typeof matches[0]?.name !== "string") {
    throw new Error("capability search did not return exactly one named match");
  }
  return { name: matches[0].name };
}

// Native OpenAI Responses witness for plain-text workloads. Unsupported tool
// scripts fail explicitly instead of pretending they executed.
async function handleAgentResponse(req, res, entry) {
  const body = await readJson(req);
  const text = agentContentText(body.input);
  const matched = agentWorkloads.filter((workload) => text.includes(workload.promptMarker));
  const model = body.model;
  const workload = matched[0];
  const base = { model, matchedMarkers: matched.map((item) => item.promptMarker), completedTools: 0, promptMarker: workload?.promptMarker ?? null, toolName: null, arguments: {} };
  if (agentRequiredHeader && req.headers[agentRequiredHeader.name.toLowerCase()] !== agentRequiredHeader.value) {
    entry.agentCompletion = { ...base, kind: "error" };
    json(res, 401, { error: { message: "provider authentication handler was bypassed" } });
    return;
  }
  if (matched.length > 1 || (workload && workload.steps.length)) {
    entry.agentCompletion = { ...base, kind: "error" };
    json(res, 400, { error: { message: "Responses witness requires one plain-text workload" } });
    return;
  }
  entry.agentCompletion = { ...base, kind: workload ? "final" : "utility" };
  const reply = workload?.finalReply ?? "Active session workload";
  const item = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
  const response = { id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!body.stream) { json(res, 200, response); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    ...Array.from({ length: 3 }, (_, index) => ({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: reply.slice(Math.floor(reply.length * index / 3), Math.floor(reply.length * (index + 1) / 3)) })),
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: reply },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  for (const [sequence_number, event] of events.entries()) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    if (event.type === "response.output_text.delta") await new Promise((resolve) => setTimeout(resolve, 80));
  }
  res.end();
}

async function handleAgentCompletion(req, res, entry) {
  const body = await readJson(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    json(res, 400, { error: { message: "completion body must be an object" } });
    return;
  }
  const model = typeof body.model === "string" ? body.model : "mock-agent-workload-model";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const conversationText = messages.map(agentContentText).join("\n");
  const latestUserIndex = messages.findLastIndex((message) => message?.role === "user");
  const latestUserText = latestUserIndex < 0 ? "" : agentContentText(messages[latestUserIndex]);
  const matched = agentWorkloads.filter((workload) =>
    workload.matchAll || (workload.latestUserTurn ? latestUserText : conversationText).includes(workload.promptMarker));
  const matchedMarkers = matched.map((workload) => workload.promptMarker);
  const workload = matched[0];
  const scopedMessages = workload?.latestUserTurn ? messages.slice(latestUserIndex + 1) : messages;
  const completedTools = scopedMessages.filter((message) => message && typeof message === "object" && message.role === "tool").length;
  const baseRequest = { model, matchedMarkers, completedTools };

  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    entry.agentCompletion = { ...baseRequest, kind: "utility", promptMarker: matchedMarkers[0] ?? null, toolName: null, arguments: {} };
    agentStream(res, model, [
      agentChunk(model, { role: "assistant" }),
      agentChunk(model, { content: "Active session workload" }),
      agentChunk(model, {}, "stop"),
    ]);
    return;
  }
  if (matchedMarkers.length !== 1) {
    entry.agentCompletion = { ...baseRequest, kind: "error", promptMarker: null, toolName: null, arguments: {} };
    json(res, 400, { error: { message: `expected one workload marker, found ${matchedMarkers.length}` } });
    return;
  }
  if (!workload) throw new Error("matched agent workload disappeared");
  if (workload.rateLimitAttempts > 0) {
    workload.rateLimitAttempts -= 1;
    entry.agentCompletion = { ...baseRequest, kind: "error", promptMarker: workload.promptMarker, toolName: null, arguments: {} };
    res.setHeader("retry-after", "5");
    json(res, 429, { error: { message: "Rate limited for lifecycle verification" } });
    return;
  }
  if (completedTools >= workload.steps.length) {
    if (workload.finalReplyDelayMs) await new Promise(resolve => setTimeout(resolve, workload.finalReplyDelayMs));
    entry.agentCompletion = { ...baseRequest, kind: "final", promptMarker: workload.promptMarker, toolName: null, arguments: {} };
    const finalReply = workload.finalReplyFrom === "last-tool-text" ? lastToolText(scopedMessages)
      : workload.finalReplyFrom === "system-text" ? messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map(agentContentText).join("\n") || "No system instructions"
      : workload.finalReply;
    if (workload.finalReplyInitiallyReleasedChunks !== null) {
      await gatedAgentStream(res, model, workload, finalReply);
    } else {
      agentStream(res, model, [
        agentChunk(model, { role: "assistant" }),
        ...(workload.finalReasoning ? [agentChunk(model, { reasoning_content: workload.finalReasoning })] : []),
        ...finalReplyChunks({ ...workload, finalReply }).map((content) => agentChunk(model, { content })),
        agentChunk(model, {}, "stop"),
      ], agentRepliesHeld);
    }
    return;
  }
  const step = workload.steps[completedTools];
  const toolName = offeredAgentTool(body, step.tool) ?? (step.allowUnadvertisedTool ? step.tool : null);
  if (!toolName) {
    entry.agentCompletion = { ...baseRequest, kind: "error", promptMarker: workload.promptMarker, toolName: step.tool, arguments: step.arguments };
    json(res, 400, { error: { message: `tool ${step.tool} was not offered to the mock agent` } });
    return;
  }
  const toolArguments = step.argumentsFrom === "computer-mention" ? computerMentionArguments(messages)
    : step.argumentsFrom === "skill-catalog" ? skillCatalogArguments(messages, step.arguments.skill)
    : step.argumentsFrom === "capability-search" ? { ...step.arguments, ...capabilitySearchArguments(scopedMessages) } : step.arguments;
  if (step.argumentsFrom === "skill-catalog" && toolArguments === null) {
    entry.agentCompletion = { ...baseRequest, kind: "final", promptMarker: workload.promptMarker, toolName: null, arguments: {} };
    agentStream(res, model, [agentChunk(model, { role: "assistant" }),
      ...finalReplyChunks(workload).map(content => agentChunk(model, { content })), agentChunk(model, {}, "stop")]);
    return;
  }
  const callId = `call_${workload.promptMarker.replace(/[^a-zA-Z0-9_-]/g, "_")}_${completedTools + 1}`;
  entry.agentCompletion = {
    ...baseRequest,
    kind: "tool",
    promptMarker: workload.promptMarker,
    toolName,
    arguments: toolArguments,
  };
  agentStream(res, model, [
    agentChunk(model, { role: "assistant" }),
    ...(step.text ? [agentChunk(model, { content: step.text })] : []),
    agentChunk(model, {
      tool_calls: [{
        index: 0,
        id: callId,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(toolArguments) },
      }],
    }),
    agentChunk(model, {}, "tool_calls"),
  ]);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function record(req, url, res) {
  const entry = {
    id: requests.length + 1,
    method: req.method,
    path: url.pathname,
    url: `${url.pathname}${url.search}`,
    at: new Date().toISOString(),
  };
  requests.push(entry);
  res.once("finish", () => { entry.status = res.statusCode; });
  console.log(`[mock-oauth-mcp] ${entry.method} ${entry.path}`);
  return entry;
}

function protectedResourceMetadata() {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: advertisedScopes,
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata() {
  return {
    issuer,
    ...(process.env.MOCK_AUTHORIZATION_RESPONSE_ISSUER === undefined ? {} : { authorization_response_iss_parameter_supported: process.env.MOCK_AUTHORIZATION_RESPONSE_ISSUER === "1" }),
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(disableDcr ? {} : { registration_endpoint: `${issuer}/register` }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: advertisedScopes,
  };
}

function basicClient(req) {
  const header = req.headers.authorization || "";
  if (header.length < 7 || header.slice(0, 6).toLowerCase() !== "basic ") return null;
  let credentialStart = 6;
  while (header[credentialStart] === " ") credentialStart += 1;
  if (credentialStart === header.length) return null;
  const decoded = Buffer.from(header.slice(credentialStart), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return { clientId: decoded, clientSecret: "" };
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

function rejectInvalidPreregisteredClient(res) {
  json(res, 400, { error: "invalid_client" });
}

function requirePreregisteredAuthorizeClient(res, params) {
  if (!disableDcr) return true;
  if (params.get("client_id") === mockClientId) return true;
  rejectInvalidPreregisteredClient(res);
  return false;
}

function requireStrictAuthorizeContract(res, params) {
  if (!strictOAuth) return true;
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const registeredRedirects = clients.get(clientId)?.redirect_uris
    ?? (clientId === mockClientId ? preregisteredRedirectUris : []);
  if (!redirectUri || !registeredRedirects.includes(redirectUri)) {
    json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri did not match any configured URIs",
    });
    return false;
  }

  const scopes = (params.get("scope") || "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => !advertisedScopes.includes(scope))) {
    json(res, 400, {
      error: "invalid_scope",
      error_description: "scope is required and must be advertised",
    });
    return false;
  }
  return true;
}

function requirePreregisteredTokenClient(req, res, form, grant) {
  if (!disableDcr) return true;
  const basic = basicClient(req);
  const clientId = basic?.clientId || form.client_id || grant?.clientId || "";
  if (clientId !== mockClientId) {
    rejectInvalidPreregisteredClient(res);
    return false;
  }
  const suppliedSecret = basic?.clientSecret ?? form.client_secret;
  if (suppliedSecret !== undefined && suppliedSecret !== mockClientSecret) {
    rejectInvalidPreregisteredClient(res);
    return false;
  }
  return true;
}

function redirectWithCode(res, params) {
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri) {
    json(res, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
    return;
  }

  const code = `mock-code-${randomUUID()}`;
  codes.set(code, {
    clientId: params.get("client_id") || "mock-client",
    codeChallenge: params.get("code_challenge") || null,
    codeChallengeMethod: params.get("code_challenge_method") || "plain",
    scope: params.get("scope") || "mcp:read mcp:write",
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  if (process.env.MOCK_AUTHORIZATION_RESPONSE_ISSUER === "1") callback.searchParams.set("iss", issuer);
  const state = params.get("state");
  if (state) callback.searchParams.set("state", state);

  res.writeHead(302, { location: callback.toString() });
  res.end();
}

function authorize(req, res, url) {
  if (!requirePreregisteredAuthorizeClient(res, url.searchParams)) {
    return;
  }
  if (!requireStrictAuthorizeContract(res, url.searchParams)) {
    return;
  }
  if (autoApprove && url.searchParams.get("force_consent") !== "1") {
    redirectWithCode(res, url.searchParams);
    return;
  }

  const approveUrl = new URL(`${issuer}/approve`);
  for (const [key, value] of url.searchParams) approveUrl.searchParams.set(key, value);
  const requestedScopes = (url.searchParams.get("scope") || "").split(/\s+/).filter(Boolean);
  const requestedScopesHtml = requestedScopes.length > 0
    ? `<h2>Requested scopes</h2><ul>${requestedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")}</ul>`
    : "";
  text(res, 200, `<!doctype html>
<html>
  <head><title>Mock MCP OAuth</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto;">
    <h1>Mock MCP OAuth</h1>
    <p>This fake OAuth provider is for OpenWork MCP end-to-end tests.</p>
    ${requestedScopesHtml}
    <form method="post" action="${escapeHtml(`${approveUrl.pathname}${approveUrl.search}`)}">
      <button style="font: inherit; padding: 10px 14px;">Approve OpenWork</button>
    </form>
  </body>
</html>`);
}

async function registerClient(req, res, entry) {
  if (disableDcr) {
    json(res, 404, { error: "not_found" });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  if (entry) {
    // Keep conformance evidence useful without recording credentials. These
    // are the public RFC 7591 fields OpenWork is expected to send.
    entry.registration = {
      application_type: body.application_type ?? null,
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      grant_types: Array.isArray(body.grant_types) ? body.grant_types : [],
      response_types: Array.isArray(body.response_types) ? body.response_types : [],
      scope: typeof body.scope === "string" ? body.scope : null,
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? null,
    };
  }
  if (rejectDcrRedirectUris === "invalid_redirect_uri") {
    json(res, 400, {
      error: "invalid_redirect_uri",
      error_description: "The provided redirect URIs are not approved for use by this authorization server.",
    });
    return;
  }
  if (rejectDcrRedirectUris === "invalid_request") {
    const firstRedirectUri = Array.isArray(body.redirect_uris) && typeof body.redirect_uris[0] === "string"
      ? body.redirect_uris[0]
      : "";
    let redirectHost = "";
    try {
      redirectHost = new URL(firstRedirectUri).host;
    } catch {
      // The mock still returns its deterministic rejection for malformed input.
    }
    json(res, 400, {
      error: "invalid_request",
      error_description: `Invalid redirect_uri: redirect_uri host '${redirectHost}' is not in the allowed list`,
    });
    return;
  }
  const clientId = `mock-client-${randomUUID()}`;
  const client = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: body.token_endpoint_auth_method || "none",
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp:read mcp:write",
  };
  clients.set(clientId, client);
  json(res, 201, client);
}

async function issueToken(req, res, entry) {
  const form = await readForm(req);
  const grantType = form.grant_type || "authorization_code";
  if (entry) entry.grantType = grantType;
  const respond = async (status, body) => {
    if (grantType === "refresh_token" && holdRefreshResponses) {
      const id = ++nextRefreshResponseId;
      await new Promise((resolve) => {
        const release = () => {
          clearTimeout(timer);
          pendingRefreshResponses.delete(id);
          if (pendingRefreshResponses.size === 0) holdRefreshResponses = false;
          resolve();
        };
        const timer = setTimeout(release, 30_000);
        pendingRefreshResponses.set(id, {
          id, status, tokenId: createHash("sha256").update(form.refresh_token || "").digest("hex").slice(0, 16), release,
        });
      });
    }
    json(res, status, body);
  };
  let grantedScope = "mcp:read mcp:write";

  const requestedClient = basicClient(req);
  const requestedClientId = requestedClient?.clientId || form.client_id || "";
  const requestedClientSecret = requestedClient?.clientSecret ?? form.client_secret ?? null;
  if (rejectsTokenClient(requestedClientId, requestedClientSecret)) {
    json(res, 400, { error: "invalid_client", error_description: "Unsupported client authentication method" });
    return;
  }

  if (grantType === "authorization_code") {
    const grant = codes.get(form.code);
    if (!grant) {
      entry.oauthError = "invalid_grant";
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    if (!requirePreregisteredTokenClient(req, res, form, grant)) {
      return;
    }
    grantedScope = grant.scope;
    if (grant.codeChallenge) {
      const verifier = form.code_verifier || "";
      const expected =
        grant.codeChallengeMethod === "S256"
          ? createHash("sha256").update(verifier).digest("base64url")
          : verifier;
      if (expected !== grant.codeChallenge) {
        json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
    if (oauthCallback.tokenErrorDescription !== undefined) {
      codes.delete(form.code);
      entry.oauthError = "invalid_grant";
      json(res, 400, { error: "invalid_grant", error_description: oauthCallback.tokenErrorDescription });
      return;
    }
  } else if (grantType === "refresh_token") {
    if (!requirePreregisteredTokenClient(req, res, form, null)) {
      return;
    }
    if (strictRefreshTokens) {
      if (!form.refresh_token || !refreshTokens.has(form.refresh_token)) {
        await respond(400, { error: "invalid_grant", error_description: "unknown refresh token" });
        return;
      }
      // Rotate, like real providers (and the Den) do: the old refresh token
      // dies with this exchange, so the client must persist the replacement.
      refreshTokens.delete(form.refresh_token);
    }
  } else if (!requirePreregisteredTokenClient(req, res, form, null)) {
    return;
  }

  if (form.code) codes.delete(form.code);
  const accessToken = `mock-access-${randomUUID()}`;
  tokens.add(accessToken);
  const refreshToken = `mock-refresh-${randomUUID()}`;
  const issueRefreshToken = oauthCallback.issueRefreshToken !== false;
  if (issueRefreshToken) refreshTokens.add(refreshToken);
  entry.tokenId = createHash("sha256").update(accessToken).digest("hex").slice(0, 12);
  entry.refreshTokenIssued = issueRefreshToken;
  await respond(200, {
    access_token: accessToken,
    ...(issueRefreshToken ? { refresh_token: refreshToken } : {}),
    token_type: "Bearer",
    expires_in: 3600,
    scope: grantedScope,
  });
}

function isAuthorized(req) {
  if (allowUnauthenticatedMcp) return true;
  const token = bearerToken(req);
  return Boolean(token && tokens.has(token));
}

/** Linear-time bearer parse — `\s+(.+)` backtracks polynomially on header spam. */
function bearerToken(req) {
  const header = req.headers.authorization || "";
  if (!/^bearer /i.test(header)) return null;
  return header.slice("bearer ".length).trim() || null;
}

/**
 * A stable, non-secret fingerprint of the caller's bearer token.
 *
 * Per-member credential modes issue a DIFFERENT token per person, so distinct
 * fingerprints are how a spec proves one member's credential was not reused for
 * another. Never log the token itself.
 */
function tokenFingerprint(req) {
  const token = bearerToken(req);
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function mcpResult(message) {
  if (configuredTools.length && message.method === "tools/list") {
    return { tools: configuredTools.map(({ result, delayMs, appHtml, validateRequiredArguments, ...tool }) => tool) };
  }
  if (message.method === "resources/read") {
    const tool = configuredTools.find((candidate) => candidate._meta?.ui?.resourceUri === message.params?.uri);
    if (tool?.appHtml !== undefined) {
      return { contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: tool.appHtml }] };
    }
  }
  if (message.method === "tools/call") {
    const tool = configuredTools.find((candidate) => candidate.name === message.params?.name);
    if (tool) return tool.result;
  }
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
          ...(configuredTools.some((tool) => tool.appHtml !== undefined) ? {
            resources: {},
            extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
          } : {}),
        },
        serverInfo: { name: "mock-oauth-mcp", version: "1.0.0" },
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "mock_echo",
            title: "Mock Echo",
            description: "Echoes the provided text from the mock OAuth MCP server.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
            },
          },
          {
            name: "mock_batch",
            description: "Echo a batch of items (nested schema for form-fallback testing).",
            inputSchema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { text: { type: "string" } },
                  },
                },
              },
              required: ["items"],
            },
          },
          ...syntheticTools,
          ...(appToolName ? [{
            name: appToolName,
            title: "Search issues (JQL)",
            description: "Runs a JQL search and renders the results as an MCP App view.",
            inputSchema: {
              type: "object",
              properties: { jql: { type: "string" } },
              required: ["jql"],
            },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
            },
            _meta: {
              ui: { resourceUri: `ui://mock/${appToolName}/view.html` },
            },
          }] : []),
          ...(extraToolName ? [{
            name: extraToolName,
            title: extraToolTitle || extraToolName,
            description: extraToolDescription,
            inputSchema: {
              type: "object",
              properties: {
                channel: { type: "string" },
                unresolved: { type: "string" },
              },
            },
          }] : []),
          ...(errorToolName ? [{
            name: errorToolName,
            title: errorToolTitle || errorToolName,
            description: errorToolDescription,
            inputSchema: { type: "object", properties: {} },
          }] : []),
        ],
      };
    case "tools/call":
      if (message.params?.name === "mock_batch") {
        const items = message.params?.arguments?.items;
        return {
          content: [
            {
              type: "text",
              text: `Received ${Array.isArray(items) ? items.length : 0} items.`,
            },
          ],
        };
      }
      if (syntheticTools.some((tool) => tool.name === message.params?.name)) {
        return {
          content: [
            {
              type: "text",
              text: `${message.params.name} ok`,
            },
          ],
        };
      }
      if (errorToolName && message.params?.name === errorToolName) {
        return {
          isError: true,
          structuredContent: {
            providerStatus: Number.isFinite(errorToolStatus) ? errorToolStatus : 403,
            category: "provider_policy",
            providerCode: "access_denied",
          },
          content: [
            {
              type: "text",
              text: "The provider rejected this operation because administrator approval is required.",
            },
          ],
        };
      }
      if (extraToolName && message.params?.name === extraToolName) {
        return {
          content: [
            {
              type: "text",
              text: extraToolResult,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: String(message.params?.arguments?.text ?? "mock oauth mcp ok"),
          },
        ],
      };
    default:
      return {};
  }
}

function mcpResponse(message) {
  if (message.method === "tools/call") {
    const tool = configuredTools.find((candidate) => candidate.name === message.params?.name);
    if (tool?.validateRequiredArguments) {
      const missing = (tool.inputSchema.required ?? []).filter((key) => message.params?.arguments?.[key] === undefined);
      if (missing.length) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: `Invalid arguments for tool ${tool.name}: ${JSON.stringify(missing.map((key) => ({ path: [key], message: "Required" })))}`,
          },
        };
      }
    }
  }
  // This fixture speaks legacy MCP. Give modern clients the explicit fallback
  // signal instead of a successful but malformed discovery response.
  if (message.method === "server/discover") {
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
  if (
    errorToolMode === "authorization_required"
    && errorToolName
    && message.method === "tools/call"
    && message.params?.name === errorToolName
  ) {
    const connectLink = `[${errorToolConnectUrl}](${errorToolConnectUrl})`;
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32001,
        message: `Authorization required — connect your ${errorToolProvider} account to use this connector. Open ${connectLink} in a browser, sign in, then retry this request.`,
        data: {
          connect_url: errorToolConnectUrl,
          provider: errorToolProvider,
        },
      },
    };
  }

  return { jsonrpc: "2.0", id: message.id, result: mcpResult(message) };
}

async function handleMcp(req, res, entry) {
  const body = await readJson(req).catch(() => ({}));
  const messages = Array.isArray(body) ? body : [body];
  entry.rpcMethods = messages
    .filter((message) => message && typeof message === "object" && typeof message.method === "string")
    .map((message) => message.method);

  const authorized = isAuthorized(req);
  entry.tokenId = tokenFingerprint(req);
  if (tokens.has(bearerToken(req)) && oauthCallback.resourceStatus !== undefined) {
    const error = oauthCallback.resourceStatus === 403 ? "insufficient_scope" : "invalid_token";
    entry.oauthError = error;
    json(res, oauthCallback.resourceStatus, { error }, {
      "www-authenticate": oauthCallback.resourceStatus === 403
        ? 'Bearer error="insufficient_scope", scope="mcp:read mcp:write"'
        : `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    });
    return;
  }
  if (!authorized) {
    json(res, 401, { error: "missing_mcp_token" }, {
      "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    });
    return;
  }

  if (req.method === "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  entry.authorized = authorized;
  entry.toolNames = messages
    .filter((message) => message && typeof message === "object" && message.method === "tools/call" && typeof message.params?.name === "string")
    .map((message) => message.params.name);
  // Arguments + a token fingerprint make the connector the AUTHORITY on who
  // called it: a spec can prove two members each invoked a tool with their own
  // credential, without trusting the app's own UI state.
  entry.toolCalls = messages
    .filter((message) => message && typeof message === "object" && message.method === "tools/call" && typeof message.params?.name === "string")
    .map((message) => ({
      name: message.params.name,
      args: message.params.arguments ?? message.params.args ?? {},
      tokenId: entry.tokenId,
    }));
  const responseDelay = Math.max(0, ...entry.toolNames.map((name) =>
    configuredTools.find((tool) => tool.name === name)?.delayMs ?? 0));
  if (responseDelay > 0) await new Promise((resolve) => setTimeout(resolve, responseDelay));
  const responses = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || message.id === undefined) return [];
    return [mcpResponse(message)];
  });

  if (responses.length === 0) {
    res.writeHead(202, { "access-control-allow-origin": "*" });
    res.end();
    return;
  }

  json(res, 200, Array.isArray(body) ? responses : responses[0]);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", issuer);
    const entry = record(req, url, res);

    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    if (url.pathname === "/health") {
      json(res, 200, { ok: true, host, issuer, autoApprove, disableDcr, requests: requests.length });
      return;
    }

    if (url.pathname === "/requests") {
      json(res, 200, { requests });
      return;
    }

    if (url.pathname === "/admin/oauth-callback" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some((key) => !["issueRefreshToken", "resourceStatus", "tokenErrorDescription"].includes(key))
        || (body.issueRefreshToken !== undefined && typeof body.issueRefreshToken !== "boolean")
        || (body.resourceStatus !== undefined && ![401, 403].includes(body.resourceStatus))
        || (body.tokenErrorDescription !== undefined && (typeof body.tokenErrorDescription !== "string"
          || !body.tokenErrorDescription || body.tokenErrorDescription.length > 512))) {
        json(res, 400, { error: "invalid_oauth_callback_options" });
        return;
      }
      oauthCallback = body;
      json(res, 200, { configured: true });
      return;
    }

    if (url.pathname === "/admin/tools" && req.method === "POST") {
      const body = await readJson(req);
      if (!Array.isArray(body?.tools) || body.tools.some((tool) => !tool || typeof tool.name !== "string" || !tool.inputSchema || !tool.result
        || (tool.delayMs !== undefined && (!Number.isFinite(tool.delayMs) || tool.delayMs < 0 || tool.delayMs > 30_000)))) {
        json(res, 400, { error: "tools must have a name, inputSchema, and result" });
        return;
      }
      configuredTools = body.tools;
      json(res, 200, { configured: configuredTools.length });
      return;
    }

    if (url.pathname === "/admin/agent-hold" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body?.held !== "boolean") throw new Error("held must be a boolean");
      agentRepliesHeld = body.held;
      if (!agentRepliesHeld) for (const send of [...heldAgentReplies]) send();
      json(res, 200, { held: agentRepliesHeld, pending: heldAgentReplies.size });
      return;
    }

    if (url.pathname === "/admin/agent-workloads" && req.method === "POST") {
      const body = await readJson(req);
      const requiredHeader = body?.requiredHeader;
      if (requiredHeader !== undefined && (!requiredHeader || typeof requiredHeader.name !== "string"
        || !requiredHeader.name.trim() || typeof requiredHeader.value !== "string" || !requiredHeader.value)) {
        json(res, 400, { error: "requiredHeader needs a name and value" });
        return;
      }
      agentWorkloads = validateAgentWorkloads(body?.workloads);
      for (const state of agentReplyGates.values()) {
        state.aborted = true;
        releaseAgentReplyWaiters(state, false);
      }
      agentReplyGates.clear();
      agentRequiredHeader = requiredHeader ?? null;
      json(res, 200, { configured: agentWorkloads.length });
      return;
    }

    if (url.pathname === "/admin/agent-reply" && req.method === "GET") {
      const promptMarker = url.searchParams.get("promptMarker") ?? "";
      const state = agentReplyGates.get(promptMarker);
      if (!state) {
        json(res, 404, { error: "agent_reply_not_started" });
        return;
      }
      json(res, 200, publicAgentReplyState(state));
      return;
    }

    if (url.pathname === "/admin/agent-reply" && req.method === "POST") {
      const body = await readJson(req);
      const state = agentReplyGates.get(body?.promptMarker);
      if (!state) {
        json(res, 404, { error: "agent_reply_not_started" });
        return;
      }
      const count = body?.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        json(res, 400, { error: "count_must_be_positive" });
        return;
      }
      state.releasedChunks = Math.min(state.totalChunks, state.releasedChunks + count);
      releaseAgentReplyWaiters(state, true);
      json(res, 200, publicAgentReplyState(state));
      return;
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      json(res, 200, {
        object: "list",
        data: [{ id: "mock-agent-workload-model", object: "model", owned_by: "openwork-testkit" }],
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      await handleAgentResponse(req, res, entry);
      return;
    }

    if (
      req.method === "POST"
      && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
    ) {
      await handleAgentCompletion(req, res, entry);
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname === "/mcp/.well-known/oauth-protected-resource"
    ) {
      json(res, 200, protectedResourceMetadata());
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      json(res, 200, authorizationServerMetadata());
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      await registerClient(req, res, entry);
      return;
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      authorize(req, res, url);
      return;
    }

    if (url.pathname === "/approve" && req.method === "POST") {
      redirectWithCode(res, url.searchParams);
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      await issueToken(req, res, entry);
      return;
    }

    // Test hook: kill every live access token (refresh grants stay valid),
    // so the next authenticated MCP call gets a 401 challenge — the same
    // thing a client sees in production when its access token expires.
    if (url.pathname === "/admin/expire-access-tokens" && req.method === "POST") {
      const expired = tokens.size;
      tokens.clear();
      json(res, 200, { expired });
      return;
    }

    // Hold completed refresh responses so a journey can commit a successful
    // rotation before delivering another request's rejection of the old grant.
    if (url.pathname === "/admin/refresh-responses" && req.method === "POST") {
      tokens.clear();
      strictRefreshTokens = true;
      holdRefreshResponses = true;
      json(res, 200, { holding: true });
      return;
    }
    if (url.pathname === "/admin/refresh-responses" && req.method === "GET") {
      json(res, 200, { responses: [...pendingRefreshResponses.values()].map(({ id, status, tokenId }) => ({ id, status, tokenId })) });
      return;
    }
    const refreshRelease = url.pathname.match(/^\/admin\/refresh-responses\/(\d+)\/release$/);
    if (refreshRelease && req.method === "POST") {
      const pending = pendingRefreshResponses.get(Number(refreshRelease[1]));
      if (!pending) { json(res, 404, { error: "unknown_refresh_response" }); return; }
      pending.release();
      json(res, 200, { released: true });
      return;
    }

    // Test hook: revoke both grants and enforce that revocation on refresh,
    // producing the 401 -> refresh -> invalid_grant path in every test lane.
    if (url.pathname === "/admin/expire-oauth-tokens" && req.method === "POST") {
      const expiredAccessTokens = tokens.size;
      const expiredRefreshTokens = refreshTokens.size;
      tokens.clear();
      refreshTokens.clear();
      strictRefreshTokens = true;
      json(res, 200, { expiredAccessTokens, expiredRefreshTokens });
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcp(req, res, entry);
      return;
    }

    if (url.pathname === "/gmail/v1/users/me/messages" && req.method === "GET") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      const messages = [...gmailThreadMessages].reverse().map((message) => ({
        id: message.id,
        threadId: message.threadId,
      }));
      json(res, 200, { messages, resultSizeEstimate: messages.length });
      return;
    }

    const gmailMessageMatch = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
    if (gmailMessageMatch && req.method === "GET") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      const message = gmailMessagesById.get(decodeURIComponent(gmailMessageMatch[1]));
      if (!message) {
        json(res, 404, { error: { code: 404, message: "Message not found" } });
        return;
      }
      json(res, 200, gmailMessageShape(message, url.searchParams.get("format")));
      return;
    }

    if (url.pathname === `/gmail/v1/users/me/threads/${gmailThreadId}` && req.method === "GET") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      json(res, 200, {
        id: gmailThreadId,
        messages: gmailThreadMessages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
          payload: message.payload,
        })),
      });
      return;
    }

    // Minimal Gmail drafts.create stand-in so the org Google Workspace flow
    // can be proven end-to-end: requires a token this mock issued, records
    // the request (external witness), returns Gmail-shaped ids.
    if (url.pathname === "/gmail/v1/users/me/drafts" && req.method === "POST") {
      if (!isAuthorized(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
        return;
      }
      const body = await readJson(req).catch(() => ({}));
      const raw = typeof body?.message?.raw === "string" ? body.message.raw : "";
      const threadId = typeof body?.message?.threadId === "string" ? body.message.threadId : null;
      drafts.push({ raw, threadId, at: new Date().toISOString() });
      json(res, 200, {
        id: `draft-${randomUUID()}`,
        message: { id: `msg-${randomUUID()}`, threadId: threadId || `thread-${randomUUID()}` },
      });
      return;
    }

    if (url.pathname === "/gmail/drafts-log") {
      json(res, 200, { drafts });
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error("[mock-oauth-mcp] request failed", error);
    json(res, 500, { error: "internal_server_error" });
  }
});

server.listen(port, host, () => {
  console.log(`[mock-oauth-mcp] listening on ${issuer}`);
  console.log(`[mock-oauth-mcp] MCP URL: ${issuer}/mcp`);
  console.log(`[mock-oauth-mcp] set AUTO_APPROVE=0 to require an approval click`);
});
