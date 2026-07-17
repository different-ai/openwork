#!/usr/bin/env node
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

import {
  OFFICE_FIXTURES,
  XLSX_FIXTURE,
} from "../fixtures/ooxml-office-fixtures.mjs";

const OFFICE_TOOL_CALL_ID = "call_write_office_artifacts";
const OFFICE_TOOL_NAME = "bash";
const MATERIALIZED_PREFIX = ".opencode/openwork/inbox/chat-attachments/";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) args.set(item.slice(2), argv[index + 1] ?? "");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.get("mode") === "xlsx" ? "xlsx" : "office";
const EXPECTED_FIXTURES = mode === "xlsx" ? { xlsx: XLSX_FIXTURE } : OFFICE_FIXTURES;
const ARTIFACT_PATHS = mode === "xlsx"
  ? { xlsx: "artifacts/RevenueWorkbook.xlsx" }
  : { docx: "artifacts/QuarterlyBrief.docx", pptx: "artifacts/LaunchRoadmap.pptx" };

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record, names) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseDataUrl(value) {
  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const mime = (match[1] ?? "application/octet-stream").trim().toLowerCase();
  const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  return { mime, data };
}

function looksBase64(value) {
  const clean = value.replace(/\s+/g, "");
  return clean.length > 32 && clean.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(clean);
}

function contextFromRecord(record, context) {
  const filename = stringField(record, ["filename", "fileName", "name"]);
  const mime = stringField(record, ["mime", "mimeType", "mediaType", "mime_type", "contentType"]);
  return {
    filename: filename || context.filename || "",
    mime: mime.includes("/") ? mime.toLowerCase() : context.mime || "",
  };
}

function addPayload(out, payload, context) {
  if (!payload.data.byteLength) return;
  out.push({
    filename: context.filename,
    mime: payload.mime || context.mime,
    data: payload.data,
    sha256: sha256(payload.data),
  });
}

function extractPayloads(value, context = { filename: "", mime: "" }) {
  const out = [];
  if (typeof value === "string") {
    const payload = parseDataUrl(value);
    if (payload) addPayload(out, payload, context);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractPayloads(item, context));
    return out;
  }

  if (!isRecord(value)) return out;

  const nextContext = contextFromRecord(value, context);
  for (const key of ["file_data", "fileData", "data", "bytes", "contentBase64"]) {
    const candidate = value[key];
    if (typeof candidate !== "string") continue;
    const dataUrl = parseDataUrl(candidate);
    if (dataUrl) {
      addPayload(out, dataUrl, nextContext);
    } else if ((nextContext.filename || nextContext.mime) && looksBase64(candidate)) {
      addPayload(out, { mime: nextContext.mime, data: Buffer.from(candidate.replace(/\s+/g, ""), "base64") }, nextContext);
    }
  }

  const url = value.url;
  if (typeof url === "string") {
    const dataUrl = parseDataUrl(url);
    if (dataUrl) addPayload(out, dataUrl, nextContext);
  }

  for (const item of Object.values(value)) {
    out.push(...extractPayloads(item, nextContext));
  }

  const seen = new Set();
  return out.filter((item) => {
    const key = `${item.filename}|${item.mime}|${item.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectPromptText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectPromptText);
  if (!isRecord(value)) return [];
  if (typeof value.role === "string" && value.role !== "user") return [];
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "text" && typeof value.text === "string") return [value.text];
  if (value.role === "user" && typeof value.content === "string") return [value.content];
  return Object.values(value).flatMap(collectPromptText);
}

function fieldValue(text, name) {
  const prefix = `${name}: `;
  const line = text.split("\n").find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

function safeWorkerRelativePath(value) {
  const clean = String(value || "").trim().replaceAll("\\", "/");
  if (!clean || clean === "unavailable" || clean.includes("\0") || clean.startsWith("/")) return "";
  const normalized = posix.normalize(clean);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) return "";
  return normalized.startsWith(MATERIALIZED_PREFIX) ? normalized : "";
}

function readMaterializedHash(relativePath) {
  if (!relativePath) return { exists: false, sha256: "" };
  const absolutePath = join(workspaceRoot, relativePath);
  if (!existsSync(absolutePath)) return { exists: false, sha256: "" };
  const data = readFileSync(absolutePath);
  return { exists: true, sha256: sha256(data), size: data.byteLength };
}

function countOfficeFileMarkers(value, context = { filename: "", mime: "" }) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countOfficeFileMarkers(item, context), 0);
  if (!isRecord(value)) return 0;

  const nextContext = contextFromRecord(value, context);
  const type = stringField(value, ["type"]).toLowerCase();
  const officeLike = Object.values(EXPECTED_FIXTURES).some((expected) => nextContext.filename === expected.filename || nextContext.mime === expected.mime);
  const fileLike = type.includes("file") || "file_data" in value || "fileData" in value || "contentBase64" in value;
  let count = officeLike && fileLike ? 1 : 0;
  for (const item of Object.values(value)) count += countOfficeFileMarkers(item, nextContext);
  return count;
}

function parseNormalizedAttachment(texts, expected) {
  const block = texts.find((text) => {
    return text.includes("OpenWork normalized an Office attachment")
      && text.includes(`filename: ${expected.filename}`)
      && text.includes(`canonical_mime: ${expected.mime}`);
  });
  if (!block) return null;

  const filename = fieldValue(block, "filename");
  const mime = fieldValue(block, "canonical_mime");
  const digest = fieldValue(block, "sha256");
  const workerRelativePath = safeWorkerRelativePath(fieldValue(block, "worker_relative_path"));
  const materialized = readMaterializedHash(workerRelativePath);
  const sentinels = expected.sentinels.map((sentinel) => ({ sentinel, found: block.includes(sentinel) }));
  return {
    received: true,
    filename,
    mime,
    sha256: digest,
    workerRelativePath,
    materializedSize: materialized.size ?? 0,
    materializedSha256: materialized.sha256,
    hashMatches: digest === expected.sha256,
    materializedHashMatches: materialized.sha256 === expected.sha256,
    mimeMatches: mime === expected.mime,
    filenameMatches: filename === expected.filename,
    pathSafe: Boolean(workerRelativePath),
    materializedExists: materialized.exists,
    sentinels,
  };
}

function verifyOfficePayloads(body) {
  const payloads = extractPayloads(body);
  const promptTexts = collectPromptText(body);
  const rawBody = JSON.stringify(body);
  const officeFileMarkers = countOfficeFileMarkers(body);
  const rawOfficeBinaryLeak = Object.values(EXPECTED_FIXTURES).some((expected) => {
    return rawBody.includes(expected.dataBase64)
      || payloads.some((item) => item.sha256 === expected.sha256 || item.filename === expected.filename || item.mime === expected.mime);
  });
  const attachments = {};

  for (const [kind, expected] of Object.entries(EXPECTED_FIXTURES)) {
    attachments[kind] = parseNormalizedAttachment(promptTexts, expected) ?? { received: false, expected };
  }

  const normalizedTextOnly = payloads.length === 0 && officeFileMarkers === 0 && !rawOfficeBinaryLeak;
  const values = Object.values(attachments);
  return {
    payloadCount: payloads.length,
    officeFileMarkers,
    rawOfficeBinaryLeak,
    normalizedTextOnly,
    promptTextCount: promptTexts.length,
    attachments,
    ok: normalizedTextOnly && values.every((item) => {
      return item.received
        && item.hashMatches
        && item.materializedHashMatches
        && item.mimeMatches
        && item.filenameMatches
        && item.pathSafe
        && item.materializedExists
        && item.sentinels.every((sentinel) => sentinel.found);
    }),
  };
}

function collectStringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectStringValues);
}

function hasIssuedToolCallId(record) {
  return [record.tool_call_id, record.toolCallId, record.tool_use_id, record.toolUseId, record.call_id, record.callId]
    .some((value) => value === OFFICE_TOOL_CALL_ID);
}

function isToolResultRecord(record) {
  const role = typeof record.role === "string" ? record.role : "";
  const type = typeof record.type === "string" ? record.type : "";
  return role === "tool" || type === "tool-result" || type === "tool_result" || type === "toolResult";
}

function hasExpectedToolOutput(record) {
  const text = collectStringValues(record).join("\n");
  return Object.values(ARTIFACT_PATHS).every((path) => text.includes(path))
    && Object.values(EXPECTED_FIXTURES).every((expected) => text.includes(expected.sha256));
}

function hasExactIssuedToolResult(value) {
  if (Array.isArray(value)) return value.some(hasExactIssuedToolResult);
  if (!isRecord(value)) return false;
  if (isToolResultRecord(value) && hasIssuedToolCallId(value) && hasExpectedToolOutput(value)) return true;
  return Object.values(value).some(hasExactIssuedToolResult);
}

function writeSse(res, chunks) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function textStream(text, id = "chatcmpl-office-text") {
  return [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function artifactWriteCommand(attachments) {
  const entries = Object.entries(ARTIFACT_PATHS).map(([kind, path]) => {
    const source = attachments[kind]?.workerRelativePath;
    if (!source) throw new Error(`Missing materialized Office path for ${kind}: ${JSON.stringify(attachments)}`);
    return { source, path };
  });
  const paths = entries.map((entry) => shellQuote(entry.path)).join(" ");
  return `set -euo pipefail
mkdir -p artifacts
${entries.map((entry) => `test -s ${shellQuote(entry.source)}\ncp ${shellQuote(entry.source)} ${shellQuote(entry.path)}`).join("\n")}
(sha256sum ${paths} 2>/dev/null || shasum -a 256 ${paths})`;
}

function toolCallStream(attachments) {
  return [
    { id: "chatcmpl-office-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    {
      id: "chatcmpl-office-tool",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: OFFICE_TOOL_CALL_ID,
                type: "function",
                function: {
                  name: OFFICE_TOOL_NAME,
                  arguments: JSON.stringify({
                    description: "Write exact materialized Office attachments as workspace artifacts",
                    command: artifactWriteCommand(attachments),
                    timeout: 10000,
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "chatcmpl-office-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function finalText() {
  return [
    ...Object.values(EXPECTED_FIXTURES).map((expected) => `Verified ${expected.filename}: ${expected.sentinels.join(" | ")}`),
    `Created ${Object.values(ARTIFACT_PATHS).join(" and ")} from the exact safely materialized Office bytes.`,
  ].join("\n");
}

const host = args.get("host") || "127.0.0.1";
const port = Number(args.get("port") || 18081);
const workspaceRoot = args.get("workspace") || process.cwd();
const sockets = new Set();
let server;

const proof = {
  ok: true,
  requests: 0,
  providerReceipt: false,
  normalizedTextOnly: false,
  exactHashes: false,
  exactMimes: false,
  materializedPaths: false,
  sentinelsExtracted: false,
  rawOfficeBinaryLeak: false,
  officeFileMarkers: 0,
  payloadCount: 0,
  toolCallIssued: false,
  toolCallCompleted: false,
  finalResponse: false,
  replayResponse: false,
  replayOfficeHistoryOk: false,
  auxiliaryRequests: 0,
  auxiliaryBeforeFinal: 0,
  auxiliaryAfterFinal: 0,
  lastAuxiliaryRequest: null,
  attachments: {},
  replay: null,
  errors: [],
};

async function readBody(req) {
  return await new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
  });
}

function updateProofFromVerification(verification, replay = false) {
  if (replay) {
    proof.replay = verification;
    proof.replayOfficeHistoryOk = verification.ok;
    return;
  }
  proof.providerReceipt = verification.ok;
  proof.normalizedTextOnly = verification.normalizedTextOnly;
  proof.exactHashes = Object.values(verification.attachments).every((item) => item.hashMatches === true && item.materializedHashMatches === true);
  proof.exactMimes = Object.values(verification.attachments).every((item) => item.mimeMatches === true);
  proof.materializedPaths = Object.values(verification.attachments).every((item) => item.pathSafe === true && item.materializedExists === true);
  proof.sentinelsExtracted = Object.values(verification.attachments).every((item) => item.sentinels?.every((sentinel) => sentinel.found));
  proof.rawOfficeBinaryLeak = verification.rawOfficeBinaryLeak;
  proof.officeFileMarkers = verification.officeFileMarkers;
  proof.payloadCount = verification.payloadCount;
  proof.attachments = verification.attachments;
}

function recordAuxiliaryRequest(phase, reason) {
  proof.auxiliaryRequests += 1;
  if (phase === "before_final") proof.auxiliaryBeforeFinal += 1;
  if (phase === "after_final") proof.auxiliaryAfterFinal += 1;
  proof.lastAuxiliaryRequest = {
    request: proof.requests,
    phase,
    reason,
  };
}

function writeAuxiliaryResponse(res, phase, reason) {
  recordAuxiliaryRequest(phase, reason);
  writeSse(res, textStream("Office attachments", "chatcmpl-office-auxiliary"));
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

async function handleChatCompletion(req, res) {
  proof.requests += 1;
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    proof.errors.push(`invalid JSON request: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (!proof.toolCallIssued) {
      const verification = verifyOfficePayloads(body);
      updateProofFromVerification(verification, false);
      if (!verification.ok) {
        proof.ok = false;
        proof.errors.push(`initial normalized Office verification failed: ${JSON.stringify(verification)}`);
        writeSse(res, textStream("Office attachment normalization verification failed before tool execution."));
        return;
      }
      proof.toolCallIssued = true;
      writeSse(res, toolCallStream(verification.attachments));
      return;
    }

    if (!proof.finalResponse) {
      if (!hasExactIssuedToolResult(body)) {
        writeAuxiliaryResponse(res, "before_final", "missing exact issued tool result");
        return;
      }
      proof.toolCallCompleted = true;
      proof.finalResponse = true;
      writeSse(res, textStream(finalText(), "chatcmpl-office-final"));
      return;
    }

    if (proof.replayResponse) {
      writeAuxiliaryResponse(res, "after_final", "replay response already completed");
      return;
    }

    const replayVerification = verifyOfficePayloads(body);
    if (!replayVerification.ok) {
      writeAuxiliaryResponse(res, "after_final", "missing verified normalized Office history");
      return;
    }
    updateProofFromVerification(replayVerification, true);
    proof.replayResponse = true;
    writeSse(res, textStream("Replay succeeded after reopening the session; Office attachment history remained readable and the follow-up was answered.", "chatcmpl-office-replay"));
  } catch (error) {
    proof.ok = false;
    proof.errors.push(error instanceof Error ? error.message : String(error));
    writeSse(res, textStream(`Office mock failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, { ok: true, port });
    return;
  }
  if (req.method === "GET" && url.pathname === "/proof") {
    sendJson(res, proof);
    return;
  }
  if (req.method === "POST" && url.pathname === "/shutdown") {
    sendJson(res, { ok: true });
    setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      server.close(() => process.exit(0));
    }, 50);
    return;
  }
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    sendJson(res, { object: "list", data: [{ id: "office-attachment-mock", object: "model" }] });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    await handleChatCompletion(req, res);
    return;
  }
  sendJson(res, { error: "not found" }, 404);
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ ok: true, host, port }));
});
