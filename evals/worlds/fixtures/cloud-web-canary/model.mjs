#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const MODEL_ID = "cloud-web-canary";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (content) => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";

export function configuration(env = process.env) {
  const workspace = env.CANARY_WORKSPACE_PATH ?? "/tmp/openwork-workspace";
  const filename = env.CANARY_FILE_NAME ?? "web-canary-note.txt";
  const marker = env.CANARY_MARKER;
  const key = env.CANARY_MODEL_KEY;
  const port = Number(env.PORT ?? "8099");
  if (!key || key.length < 16) throw new Error("CANARY_MODEL_KEY must contain at least 16 characters");
  if (!marker || !/^[A-Za-z0-9_-]{8,128}$/.test(marker)) throw new Error("CANARY_MARKER must be a synthetic 8-128 character identifier");
  if (!/^[A-Za-z0-9_-]+\.txt$/.test(filename)) throw new Error("CANARY_FILE_NAME must be a plain .txt filename");
  if (!posix.isAbsolute(workspace) || posix.normalize(workspace) !== workspace || /[\x00-\x1f\\]/.test(workspace)) {
    throw new Error("CANARY_WORKSPACE_PATH must be a normalized absolute POSIX directory");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid port");
  return { key, port, workspace, filename, marker, filePath: posix.join(workspace, filename) };
}

function fileTool(tools, kind, config) {
  const candidates = tools.filter((tool) => tool.type === "function" && record(tool.function)
    && new RegExp(`(^|_)${kind}$`, "i").test(tool.function.name));
  if (candidates.length !== 1) throw new Error(`Expected one advertised ${kind} tool`);
  const tool = candidates[0].function;
  const schema = tool.parameters;
  if (!record(schema) || !record(schema.properties)) throw new Error("Missing file tool schema");
  const properties = schema.properties;
  const pathKey = ["filePath", "file_path", "path"].find((name) => properties[name]?.type === "string");
  if (!pathKey || (kind === "write" && properties.content?.type !== "string")) throw new Error("Unsupported file tool schema");
  const args = { [pathKey]: config.filePath, ...(kind === "write" ? { content: `${config.marker}\n` } : {}) };
  for (const name of schema.required ?? []) {
    if (!(name in args)) throw new Error("Unsupported required file tool argument");
  }
  return { name: tool.name, arguments: JSON.stringify(args) };
}

// OpenCode v1 read outputs: current <content>1: ... or legacy <file>00001| ... .
// Require a numbered file line, not a marker echoed in a prompt, error or old message.
function observedFile(content, config) {
  const output = text(content);
  const path = output.match(/<path>([^<]+)<\/path>/)?.[1];
  if (path && path !== config.filePath) return null;
  if (/\b(error|denied|not found|ENOENT)\b/i.test(output)) return null;
  const body = output.match(/<content>([\s\S]*?)<\/content>/)?.[1]
    ?? output.match(/<file>([\s\S]*?)<\/file>/)?.[1];
  if (!body) return null;
  const lines = [...body.matchAll(/^\s*(\d+)(?:: |\| ?)([^\r\n]*)/gm)];
  if (lines.length < 1 || lines.length > 2 || Number(lines[0][1]) !== 1 || lines[0][2] !== config.marker
    || (lines.length === 2 && (Number(lines[1][1]) !== 2 || lines[1][2] !== ""))) return null;
  return `${lines[0][2]}\n`; // Canonical line hash, not a claim about unobserved raw file bytes.
}

export function createCanaryModel(config, { streamDelayMs = 2_000 } = {}) {
  const turns = new Map();
  const calls = new Map();
  const stats = {
    requests: 0, auxiliaryRequests: 0, writeToolCalls: 0, readToolCalls: 0,
    verifiedReads: 0, rejectedReadResults: 0, protocolErrors: 0,
    streamedReplies: 0, upstreamCalls: 0, readReceipts: [],
  };

  function completion(body) {
    stats.requests += 1;
    if (!Array.isArray(body.messages)) throw new Error("messages must be an array");
    const messages = body.messages;
    const userIndex = messages.findLastIndex((message) => message.role === "user");
    const prompt = userIndex < 0 ? "" : text(messages[userIndex].content);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasFile = prompt.includes(config.filename);
    const create = hasFile && /\b(create|write)\b/i.test(prompt) && prompt.includes(config.marker);
    const read = hasFile && /\bread\b/i.test(prompt);
    // Title, compaction and provider probes have no tools (or explicitly forbid them).
    const auxiliary = messages.some((message) => message.role === "system"
      && /you are a title generator|you are a helpful AI assistant tasked with summarizing/i.test(text(message.content)));
    if (auxiliary || !tools.length || body.tool_choice === "none" || (!create && !read)) {
      stats.auxiliaryRequests += 1;
      return { content: "Canary note" };
    }
    if (body.model !== MODEL_ID) throw new Error("Unexpected canary model");
    // Include the user position: a repeated read prompt is still a NEW turn.
    const turnKey = digest(`${userIndex}:${prompt}`);
    let turn = turns.get(turnKey);
    if (!turn) {
      if (turns.size >= 16) throw new Error("Canary turn limit exceeded");
      if (create && turns.size > 0) throw new Error("Refusing a second write turn");
      turn = { number: turns.size + 1, create, write: null, read: null, verified: null };
      turns.set(turnKey, turn);
    }
    const current = messages.slice(userIndex + 1);
    function issue(kind) {
      const fn = fileTool(tools, kind, config);
      if (!turn[kind]) {
        const id = `call_canary_${turn.number}_${kind}`;
        turn[kind] = id;
        calls.set(id, { turnKey, kind, fn });
        stats[kind === "write" ? "writeToolCalls" : "readToolCalls"] += 1;
      }
      const call = calls.get(turn[kind]);
      return { tool_calls: [{ id: turn[kind], type: "function", function: call.fn }] };
    }
    function result(kind) {
      const id = turn[kind];
      if (!id || calls.get(id)?.turnKey !== turnKey) return null;
      const issuedAt = current.findIndex((message) => message.role === "assistant"
        && message.tool_calls?.some((call) => {
          if (call.id !== id || call.function?.name !== calls.get(id).fn.name) return false;
          const actual = JSON.parse(call.function.arguments);
          const expected = JSON.parse(calls.get(id).fn.arguments);
          return record(actual) && Object.keys(actual).length === Object.keys(expected).length
            && Object.entries(expected).every(([key, value]) => actual[key] === value);
        }));
      if (issuedAt < 0) return null;
      return current.slice(issuedAt + 1).find((message) => message.role === "tool" && message.tool_call_id === id) ?? null;
    }
    if (turn.create) {
      const written = result("write");
      if (!written) return issue("write");
      if (/\b(error|denied|ENOENT)\b|prevents you from using this specific tool call/i.test(text(written.content))) throw new Error("Engine write failed");
    }
    const readResult = result("read");
    if (!readResult) return issue("read");
    const observed = observedFile(readResult.content, config);
    if (observed === null) {
      stats.rejectedReadResults += 1;
      throw new Error("Fresh engine read did not contain the expected file line");
    }
    if (!turn.verified) {
      turn.verified = { sequence: ++stats.verifiedReads, turn: turn.number, sha256: digest(observed) };
      stats.readReceipts.push(turn.verified);
    }
    // The response and receipt derive from this correlated tool result, not an
    // independent observation of runtime file bytes or persistence after restart.
    return { content: `Canary read ${turn.verified.sequence}: ${observed.trimEnd()}`, verified: true };
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${config.key}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/stats") return json(res, 200, stats);
      if (req.method === "GET" && req.url === "/v1/models") {
        return json(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "canary", name: "Canary" }] });
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, { error: "not_found" });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return json(res, 413, { error: "request_too_large" });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const answer = completion(body);
      const id = `chatcmpl-canary-${stats.requests}`;
      const finish = answer.tool_calls ? "tool_calls" : "stop";
      const message = { role: "assistant", content: answer.content ?? null, ...(answer.tool_calls ? { tool_calls: answer.tool_calls } : {}) };
      if (!body.stream) return json(res, 200, { id, object: "chat.completion", created: 0, model: MODEL_ID, choices: [{ index: 0, message, finish_reason: finish }] });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
      res.flushHeaders();
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: "assistant" });
      if (answer.tool_calls) {
        const call = answer.tool_calls[0];
        send({ tool_calls: [{ index: 0, ...call, function: { name: call.function.name, arguments: "" } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] });
      } else if (answer.verified) {
        stats.streamedReplies += 1;
        const boundary = answer.content.indexOf(":") + 1;
        send({ content: answer.content.slice(0, boundary) });
        await delay(streamDelayMs);
        if (res.destroyed) return;
        send({ content: answer.content.slice(boundary) });
      } else {
        send({ content: answer.content });
      }
      send({}, finish);
      res.end("data: [DONE]\n\n");
    } catch {
      stats.protocolErrors += 1;
      if (!res.headersSent) json(res, 400, { error: { message: "Canary protocol rejected request or tool result", type: "canary_protocol_error" } });
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration();
  const server = createCanaryModel(config);
  server.listen(config.port, "0.0.0.0", () => console.log("Canary model listening"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.closeAllConnections(); server.close(); });
}
