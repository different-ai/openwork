import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkedExec,
  defaultDaytonaExec,
  deleteSandboxes,
  execInSandbox,
} from "@openwork/hosts";
import { trackResource } from "@openwork/world";
import type { Server, ServerResponse } from "node:http";
import { SkipError } from "./needs.ts";
import type { Place } from "./place.ts";
import type { DaytonaExec, DaytonaExecResult } from "@openwork/hosts";

const IMAGE = "ghcr.io/berriai/litellm:v1.97.0@sha256:468c25f35f3e5ec4e414974f00deab93337b1b4d9953cabcfd3722e59415f834";
const POSTGRES_IMAGE = "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const COMMAND_TIMEOUT_MS = 180_000;
const STARTUP_TIMEOUT_MS = 90_000;
const DATABASE_STARTUP_TIMEOUT_MS = 300_000;
const POSTGRES_STARTUP_TIMEOUT_MS = 90_000;
const EXEC_READY_TIMEOUT_MS = 180_000;
const PREVIEW_EXPIRY_SECONDS = 7_200;
const DAYTONA_PROXY_PORT = 4_000;
const DAYTONA_WITNESS_PORT = 4_001;
const DAYTONA_CONFIG = "/tmp/openwork-litellm-config.json";
const DAYTONA_WITNESS = "/tmp/openwork-litellm-witness.py";
const DAYTONA_LOG = "/tmp/openwork-litellm.log";
const DAYTONA_WITNESS_LOG = "/tmp/openwork-litellm-witness.log";
const BASE64_CHUNK_LENGTH = 8 * 1_024;
const MAX_DAYTONA_COMMAND_LENGTH = 12 * 1_024;
const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

const DAYTONA_DOCKERFILE = `FROM ${IMAGE}
USER root
ENTRYPOINT ["/usr/bin/bash", "-lc"]
CMD ["sleep infinity"]
`;

const DAYTONA_WITNESS_SOURCE = `import argparse
import base64
import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_BODY_BYTES = 1048576
REQUESTS = []
SEQUENCE = 0
LOCK = threading.Lock()


def fingerprint(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def send_json(self, status, value):
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def token_fingerprint(self):
        authorization = self.headers.get("authorization", "")
        token = authorization[7:].strip() if authorization.startswith("Bearer ") else ""
        return fingerprint(token)

    def control_authorized(self):
        return hmac.compare_digest(self.token_fingerprint(), OPTIONS.control_token_id)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/v1/models":
            self.send_json(200, {
                "object": "list",
                "data": [{"id": MODEL, "object": "model", "owned_by": "openwork-testkit"}],
            })
            return
        if parsed.path not in ("/__openwork_litellm/health", "/__openwork_litellm/requests"):
            self.send_json(404, {"error": {"message": "not found"}})
            return
        if not self.control_authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        with LOCK:
            sequence = SEQUENCE
            if parsed.path == "/__openwork_litellm/health":
                self.send_json(200, {"ok": True, "sequence": sequence})
                return
            values = parse_qs(parsed.query).get("after", ["0"])
            try:
                after = int(values[0])
            except ValueError:
                self.send_json(400, {"error": "invalid cursor"})
                return
            if after < 0:
                self.send_json(400, {"error": "invalid cursor"})
                return
            requests = [entry.copy() for entry in REQUESTS if entry["sequence"] > after]
        self.send_json(200, {"sequence": sequence, "requests": requests})

    def do_POST(self):
        global SEQUENCE
        path = urlsplit(self.path).path
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self.send_json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": {"message": "invalid content length"}})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self.send_json(413, {"error": {"message": "request body too large"}})
            return
        body_text = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            body = json.loads(body_text)
        except json.JSONDecodeError:
            body = None
        model = body.get("model", "") if isinstance(body, dict) and isinstance(body.get("model"), str) else ""
        token_id = self.token_fingerprint()
        with LOCK:
            SEQUENCE += 1
            sequence = SEQUENCE
            REQUESTS.append({
                "sequence": sequence,
                "model": model,
                "tokenId": token_id,
                "bodyText": body_text,
            })
        if not hmac.compare_digest(token_id, OPTIONS.upstream_token_id):
            self.send_json(401, {"error": {"message": "unauthorized"}})
            return
        completion_id = "chatcmpl-openwork-" + str(sequence)
        if isinstance(body, dict) and body.get("stream") is True:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            chunks = [
                {"id": completion_id, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": REPLY}, "finish_reason": None}]},
                {"id": completion_id, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            for chunk in chunks:
                self.wfile.write(("data: " + json.dumps(chunk, separators=(",", ":")) + "\\n\\n").encode("utf-8"))
            self.wfile.write(b"data: [DONE]\\n\\n")
            self.wfile.flush()
            return
        self.send_json(200, {
            "id": completion_id,
            "object": "chat.completion",
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 8, "total_tokens": 16},
        })


parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--model-b64", required=True)
parser.add_argument("--reply-b64", required=True)
parser.add_argument("--upstream-token-id", required=True)
parser.add_argument("--control-token-id", required=True)
OPTIONS = parser.parse_args()
MODEL = base64.b64decode(OPTIONS.model_b64).decode("utf-8")
REPLY = base64.b64decode(OPTIONS.reply_b64).decode("utf-8")
ThreadingHTTPServer(("0.0.0.0", OPTIONS.port), Handler).serve_forever()
`;

export interface LiteLlmUpstreamRequest {
  sequence: number;
  model: string;
  tokenId: string;
  bodyText: string;
}

export interface LiteLlmHandle extends AsyncDisposable {
  baseUrl: string;
  apiKey: string;
  upstreamKey: string;
  tokenId(key: string): string;
  checkpoint(): Promise<number>;
  waitForUpstreamRequest(input: { after: number; model: string; key: string; timeoutMs: number }): Promise<LiteLlmUpstreamRequest>;
  upstreamRequests(input: { after: number }): Promise<LiteLlmUpstreamRequest[]>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface WitnessState {
  requests: LiteLlmUpstreamRequest[];
  sequence: number;
}

interface LiteLlmSecrets {
  masterKey: string;
  upstreamKey: string;
  controlKey: string;
}

interface HandleInput extends LiteLlmSecrets {
  baseUrl: string;
  controlUrl: string;
  fetchImpl: typeof fetch;
  redactedSecrets?: string[];
  dispose(): Promise<void>;
}

function run(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1_024 * 1_024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function tokenId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function bearerToken(value: string | undefined): string {
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

function redactedError(error: unknown, secrets: string[]): Error {
  return new Error(redact(messageText(error), secrets));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function validCursor(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("LiteLLM sequence cursor must be a non-negative integer.");
  return value;
}

function parseUpstreamRequest(value: unknown): LiteLlmUpstreamRequest {
  if (!isRecord(value)
    || typeof value.sequence !== "number"
    || !Number.isInteger(value.sequence)
    || value.sequence < 1
    || typeof value.model !== "string"
    || typeof value.tokenId !== "string"
    || typeof value.bodyText !== "string") {
    throw new Error("LiteLLM witness request response has an invalid shape.");
  }
  return {
    sequence: value.sequence,
    model: value.model,
    tokenId: value.tokenId,
    bodyText: value.bodyText,
  };
}

function parseHealth(value: unknown): number {
  if (!isRecord(value)
    || value.ok !== true
    || typeof value.sequence !== "number"
    || !Number.isInteger(value.sequence)
    || value.sequence < 0) {
    throw new Error("LiteLLM witness health response has an invalid shape.");
  }
  return value.sequence;
}

function parseRequests(value: unknown, after: number): LiteLlmUpstreamRequest[] {
  if (!isRecord(value) || !Array.isArray(value.requests)) {
    throw new Error("LiteLLM witness requests response has an invalid shape.");
  }
  return value.requests.map(parseUpstreamRequest).filter((request) => request.sequence > after);
}

async function controlJson(fetchImpl: typeof fetch, controlUrl: string, controlKey: string, path: string): Promise<unknown> {
  const response = await fetchImpl(`${controlUrl}${path}`, {
    headers: { authorization: `Bearer ${controlKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`LiteLLM witness control ${path} failed with HTTP ${response.status}.`);
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    throw new Error(`LiteLLM witness control ${path} returned invalid JSON.`);
  }
}

function makeHandle(input: HandleInput): LiteLlmHandle {
  const secrets = [input.masterKey, input.upstreamKey, input.controlKey, ...(input.redactedSecrets ?? [])];
  let disposed = false;
  const upstreamRequests = async ({ after }: { after: number }): Promise<LiteLlmUpstreamRequest[]> => {
    const cursor = validCursor(after);
    try {
      return parseRequests(
        await controlJson(input.fetchImpl, input.controlUrl, input.controlKey, `/__openwork_litellm/requests?after=${cursor}`),
        cursor,
      );
    } catch (error) {
      throw redactedError(error, secrets);
    }
  };
  return {
    baseUrl: input.baseUrl,
    apiKey: input.masterKey,
    upstreamKey: input.upstreamKey,
    tokenId,
    async checkpoint(): Promise<number> {
      try {
        return parseHealth(await controlJson(
          input.fetchImpl,
          input.controlUrl,
          input.controlKey,
          "/__openwork_litellm/health",
        ));
      } catch (error) {
        throw redactedError(error, secrets);
      }
    },
    upstreamRequests,
    async waitForUpstreamRequest({ after, model, key, timeoutMs }) {
      const cursor = validCursor(after);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("LiteLLM request timeout must be positive.");
      const deadline = Date.now() + timeoutMs;
      const expectedTokenId = tokenId(key);
      let observed: LiteLlmUpstreamRequest[] = [];
      while (Date.now() < deadline) {
        observed = await upstreamRequests({ after: cursor });
        const found = observed.find((request) => request.model === model && request.tokenId === expectedTokenId);
        if (found) return found;
        await delay(100);
      }
      const summary = observed.map((request) => ({
        sequence: request.sequence,
        model: request.model,
        tokenId: request.tokenId,
      }));
      throw new Error(`Upstream did not receive model ${model} with token fingerprint ${expectedTokenId}. Observed: ${JSON.stringify(summary)}`);
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      try {
        await input.dispose();
        disposed = true;
      } catch (error) {
        throw redactedError(error, secrets);
      }
    },
  };
}

function startWitness(
  modelId: string,
  reply: string,
  upstreamTokenId: string,
  controlTokenId: string,
  state: WitnessState,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      writeJson(response, 200, { object: "list", data: [{ id: modelId, object: "model", owned_by: "openwork-testkit" }] });
      return;
    }
    if (request.method === "GET"
      && (url.pathname === "/__openwork_litellm/health" || url.pathname === "/__openwork_litellm/requests")) {
      if (tokenId(bearerToken(request.headers.authorization)) !== controlTokenId) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/__openwork_litellm/health") {
        writeJson(response, 200, { ok: true, sequence: state.sequence });
        return;
      }
      const afterText = url.searchParams.get("after") ?? "0";
      const after = Number(afterText);
      if (!Number.isInteger(after) || after < 0) {
        writeJson(response, 400, { error: "invalid cursor" });
        return;
      }
      writeJson(response, 200, {
        sequence: state.sequence,
        requests: state.requests.filter((entry) => entry.sequence > after),
      });
      return;
    }
    if (request.method !== "POST" || (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions")) {
      writeJson(response, 404, { error: { message: "not found" } });
      return;
    }

    let bodyText = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { bodyText += chunk; });
    request.on("end", () => {
      let body: unknown = null;
      try { body = JSON.parse(bodyText); } catch { body = null; }
      const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
      const requestTokenId = tokenId(bearerToken(request.headers.authorization));
      state.sequence += 1;
      const sequence = state.sequence;
      state.requests.push({ sequence, model, tokenId: requestTokenId, bodyText });
      if (requestTokenId !== upstreamTokenId) {
        writeJson(response, 401, { error: { message: "unauthorized" } });
        return;
      }
      const id = `chatcmpl-openwork-${sequence}`;
      if (isRecord(body) && body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "close",
        });
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      writeJson(response, 200, {
        id,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("LiteLLM upstream witness did not bind a TCP port."));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function liteLlmConfig(
  modelId: string,
  apiBase: string,
  masterKey: string,
  upstreamKey: string,
  maxInputTokens: number,
  maxOutputTokens: number,
): string {
  return JSON.stringify({
    model_list: [{
      model_name: modelId,
      litellm_params: {
        model: `openai/${modelId}`,
        api_base: apiBase,
        api_key: upstreamKey,
      },
      model_info: {
        max_input_tokens: maxInputTokens,
        max_output_tokens: maxOutputTokens,
        supports_function_calling: true,
        supports_vision: true,
        supports_reasoning: false,
        supports_response_schema: true,
        supported_openai_params: ["temperature", "tools", "response_format"],
      },
    }],
    general_settings: { master_key: masterKey },
  }, null, 2);
}

function positiveTokenLimit(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a finite positive number.`);
  return value;
}

async function mappedPort(container: string): Promise<number> {
  const result = await run("docker", ["port", container, "4000/tcp"], 10_000);
  const match = result.stdout.match(/:(\d+)\s*$/m);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`docker port returned an invalid mapping: ${result.stdout.trim()}`);
  return port;
}

async function mappedPostgresPort(container: string): Promise<number> {
  const result = await run("docker", ["port", container, "5432/tcp"], 10_000);
  const match = result.stdout.match(/:(\d+)\s*$/m);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`docker port returned an invalid Postgres mapping: ${result.stdout.trim()}`);
  return port;
}

function modelIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []);
}

async function waitForLocalProxy(container: string, apiKey: string, modelId: string): Promise<number> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let port = 0;
  let last = "proxy not queried";
  while (Date.now() < deadline) {
    try {
      port ||= await mappedPort(container);
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const body: unknown = await response.json();
      if (response.ok && modelIds(body).includes(modelId)) return port;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(500);
  }
  throw new Error(`LiteLLM did not expose model ${modelId} within ${STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
}

async function waitForLocalDatabaseProxy(container: string, apiKey: string, modelId: string): Promise<number> {
  const deadline = Date.now() + DATABASE_STARTUP_TIMEOUT_MS;
  let port = 0;
  let modelsReady = false;
  let last = "proxy not queried";
  while (Date.now() < deadline) {
    try {
      port ||= await mappedPort(container);
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const body: unknown = await response.json();
      if (response.ok && modelIds(body).includes(modelId)) {
        modelsReady = true;
        break;
      }
      last = `models HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(1_000);
  }
  if (!port || !modelsReady) {
    throw new Error(`LiteLLM did not expose model ${modelId} within ${DATABASE_STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
  }

  const keyManagementDeadline = Date.now() + DATABASE_STARTUP_TIMEOUT_MS;
  while (Date.now() < keyManagementDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/key/generate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ models: [modelId], duration: "5m" }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return port;
      last = `key management HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(1_000);
  }
  throw new Error(`LiteLLM key management did not become ready within ${DATABASE_STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
}

async function waitForPostgres(container: string): Promise<void> {
  const deadline = Date.now() + POSTGRES_STARTUP_TIMEOUT_MS;
  let last = "pg_isready not attempted";
  while (Date.now() < deadline) {
    try {
      await run("docker", ["exec", container, "pg_isready", "--username", "postgres", "--dbname", "litellm"], 5_000);
      return;
    } catch (error) {
      last = messageText(error);
    }
    await delay(500);
  }
  throw new Error(`LiteLLM Postgres did not become ready within ${POSTGRES_STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
}

async function startLocalLiteLlm(
  input: {
    modelId: string;
    reply: string;
    database?: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
  },
  secrets: LiteLlmSecrets,
): Promise<LiteLlmHandle> {
  try {
    await run("docker", ["info"], 15_000);
  } catch {
    throw new SkipError("Docker daemon is unavailable");
  }

  const state: WitnessState = { requests: [], sequence: 0 };
  const container = `openwork-litellm-${randomBytes(8).toString("hex")}`;
  const postgresContainer = input.database ? `openwork-litellm-postgres-${randomBytes(8).toString("hex")}` : "";
  const postgresPassword = input.database ? randomBytes(32).toString("hex") : "";
  let root = "";
  let witness: Server | null = null;
  try {
    const startedWitness = await startWitness(
      input.modelId,
      input.reply,
      tokenId(secrets.upstreamKey),
      tokenId(secrets.controlKey),
      state,
    );
    witness = startedWitness.server;
    root = await realpath(await mkdtemp(join(tmpdir(), "openwork-litellm-")));
    await trackResource({ kind: "tmpdir", id: root, label: "litellm-config" });
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      liteLlmConfig(
        input.modelId,
        `http://host.docker.internal:${startedWitness.port}/v1`,
        secrets.masterKey,
        secrets.upstreamKey,
        input.maxInputTokens,
        input.maxOutputTokens,
      ),
      { mode: 0o600 },
    );
    let postgresPort = 0;
    if (input.database) {
      await run("docker", [
        "create", "--name", postgresContainer,
        "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
        "--env", "POSTGRES_DB=litellm",
        "--publish", "127.0.0.1::5432",
        POSTGRES_IMAGE,
      ]);
      await trackResource({ kind: "docker", id: postgresContainer, label: "litellm-postgres" });
      await run("docker", ["start", postgresContainer], 30_000);
      postgresPort = await mappedPostgresPort(postgresContainer);
      await waitForPostgres(postgresContainer);
    }
    const createArgs = input.database
      ? [
          "create", "--name", container,
          "--add-host", "host.docker.internal:host-gateway",
          "--publish", "127.0.0.1::4000",
          "--env", `DATABASE_URL=postgresql://postgres:${postgresPassword}@host.docker.internal:${postgresPort}/litellm`,
          IMAGE, "--config", "/app/config.json", "--port", "4000",
        ]
      : [
          "create", "--name", container,
          "--add-host", "host.docker.internal:host-gateway",
          "--publish", "127.0.0.1::4000",
          IMAGE, "--config", "/app/config.json", "--port", "4000",
        ];
    await run("docker", createArgs);
    await trackResource({ kind: "docker", id: container, label: "litellm" });
    await run("docker", ["cp", configPath, `${container}:/app/config.json`], 30_000);
    await run("docker", ["start", container], 30_000);
    const port = input.database
      ? await waitForLocalDatabaseProxy(container, secrets.masterKey, input.modelId)
      : await waitForLocalProxy(container, secrets.masterKey, input.modelId);
    let placementDisposed = false;
    return makeHandle({
      ...secrets,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      controlUrl: `http://127.0.0.1:${startedWitness.port}`,
      fetchImpl: fetch,
      redactedSecrets: input.database ? [postgresPassword] : undefined,
      async dispose(): Promise<void> {
        if (placementDisposed) return;
        await run("docker", ["rm", "--force", "--volumes", container], 20_000).catch(() => undefined);
        if (input.database) {
          await run("docker", ["rm", "--force", "--volumes", postgresContainer], 20_000).catch(() => undefined);
        }
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          closeServer(startedWitness.server),
        ]);
        placementDisposed = true;
      },
    });
  } catch (error) {
    const logs = await run("docker", ["logs", container], 10_000).then((result) => result.stdout + result.stderr, () => "");
    const postgresLogs = input.database
      ? await run("docker", ["logs", postgresContainer], 10_000).then((result) => result.stdout + result.stderr, () => "")
      : "";
    await run("docker", ["rm", "--force", "--volumes", container], 20_000).catch(() => undefined);
    if (input.database) {
      await run("docker", ["rm", "--force", "--volumes", postgresContainer], 20_000).catch(() => undefined);
    }
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (witness) await closeServer(witness).catch(() => undefined);
    throw redactedError(
      `${messageText(error)}${logs ? `\nDocker logs:\n${logs.slice(-4_000)}` : ""}${postgresLogs ? `\nPostgres logs:\n${postgresLogs.slice(-4_000)}` : ""}`,
      [secrets.masterKey, secrets.upstreamKey, secrets.controlKey, ...(input.database ? [postgresPassword] : [])],
    );
  }
}

export function liteLlmSandboxName(): string {
  return `openwork-litellm-eval-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function uploadCommands(content: string, remotePath: string): string[] {
  const source = Buffer.from(content);
  const encoded = source.toString("base64");
  const encodedPath = `${remotePath}.b64`;
  const commands = [`: > ${encodedPath}`];
  for (let offset = 0; offset < encoded.length; offset += BASE64_CHUNK_LENGTH) {
    commands.push(`printf %s ${encoded.slice(offset, offset + BASE64_CHUNK_LENGTH)} >> ${encodedPath}`);
  }
  commands.push([
    "decode_status=0",
    `base64 -d ${encodedPath} > ${remotePath} || decode_status=$?`,
    `actual_bytes=$(wc -c < ${remotePath})`,
    `rm -f ${encodedPath}`,
    `test "$decode_status" -eq 0 && test "$actual_bytes" -eq ${source.byteLength}`,
  ].join("; "));
  return commands;
}

async function remoteExec(
  exec: DaytonaExec,
  sandbox: string,
  script: string,
  context: string,
  timeoutMs = 30_000,
): Promise<DaytonaExecResult> {
  const commandLength = ["exec", sandbox, "--", `bash -lc '${script}'`].join(" ").length;
  if (commandLength > MAX_DAYTONA_COMMAND_LENGTH) {
    throw new Error(`LiteLLM Daytona command is ${commandLength} characters; maximum is ${MAX_DAYTONA_COMMAND_LENGTH}.`);
  }
  return execInSandbox(exec, sandbox, script, { context, timeoutMs });
}

async function waitForExecReady(exec: DaytonaExec, sandbox: string): Promise<void> {
  const deadline = Date.now() + EXEC_READY_TIMEOUT_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      await remoteExec(exec, sandbox, "true", `LiteLLM sandbox exec-ready gate for ${sandbox}`, 15_000);
      return;
    } catch (error) {
      last = messageText(error);
    }
    await delay(2_000);
  }
  throw new Error(`LiteLLM sandbox ${sandbox} did not become exec-ready within ${EXEC_READY_TIMEOUT_MS}ms. Last: ${last}`);
}

function firstHttpsUrl(text: string): string | null {
  const match = /https:\/\/[^\s"'<>)]+/.exec(text);
  return match ? match[0].replace(/[.,;:]+$/, "") : null;
}

async function previewUrl(exec: DaytonaExec, sandbox: string, port: number): Promise<string> {
  const result = await checkedExec(
    exec,
    ["preview-url", sandbox, "-p", String(port), "--expires", String(PREVIEW_EXPIRY_SECONDS)],
    `LiteLLM preview URL gate for ${sandbox}:${port}`,
    { timeoutMs: 60_000 },
  );
  const url = firstHttpsUrl(result.stdout);
  if (!url) throw new Error(`LiteLLM preview URL gate for ${sandbox}:${port} did not return an HTTPS URL.`);
  return url;
}

async function waitForDaytonaReady(
  fetchImpl: typeof fetch,
  gatewayUrl: string,
  controlUrl: string,
  modelId: string,
  secrets: LiteLlmSecrets,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    let healthResponse: Response;
    try {
      healthResponse = await fetchImpl(`${controlUrl}/__openwork_litellm/health`, {
        headers: { authorization: `Bearer ${secrets.controlKey}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      last = `control: ${messageText(error)}`;
      await delay(1_000);
      continue;
    }
    if (!healthResponse.ok) {
      last = `control HTTP ${healthResponse.status}`;
      await delay(1_000);
      continue;
    }
    let health: unknown;
    try {
      health = await healthResponse.json();
    } catch {
      throw new Error("LiteLLM authenticated control health returned invalid JSON.");
    }
    parseHealth(health);

    let modelsResponse: Response;
    try {
      modelsResponse = await fetchImpl(`${gatewayUrl}/v1/models`, {
        headers: { authorization: `Bearer ${secrets.masterKey}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      last = `models: ${messageText(error)}`;
      await delay(1_000);
      continue;
    }
    if (!modelsResponse.ok) {
      last = `models HTTP ${modelsResponse.status}`;
      await delay(1_000);
      continue;
    }
    let models: unknown;
    try {
      models = await modelsResponse.json();
    } catch {
      throw new Error("LiteLLM /v1/models readiness gate returned invalid JSON.");
    }
    if (!modelIds(models).includes(modelId)) {
      throw new Error(`LiteLLM /v1/models readiness gate did not include model ${modelId}.`);
    }
    return;
  }
  throw new Error(`LiteLLM Daytona readiness gate timed out after ${STARTUP_TIMEOUT_MS}ms. Last: ${last}`);
}

function launchCommand(input: { modelId: string; reply: string; upstreamTokenId: string; controlTokenId: string }): string {
  const model = Buffer.from(input.modelId).toString("base64");
  const reply = Buffer.from(input.reply).toString("base64");
  return `/app/.venv/bin/python3 - <<PYEOF
import subprocess
witness_log = open("${DAYTONA_WITNESS_LOG}", "ab", buffering=0)
subprocess.Popen(["/app/.venv/bin/python3", "${DAYTONA_WITNESS}", "--port", "${DAYTONA_WITNESS_PORT}", "--model-b64", "${model}", "--reply-b64", "${reply}", "--upstream-token-id", "${input.upstreamTokenId}", "--control-token-id", "${input.controlTokenId}"], stdin=subprocess.DEVNULL, stdout=witness_log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
proxy_log = open("${DAYTONA_LOG}", "ab", buffering=0)
subprocess.Popen(["/app/.venv/bin/litellm", "--config", "${DAYTONA_CONFIG}", "--host", "0.0.0.0", "--port", "${DAYTONA_PROXY_PORT}"], stdin=subprocess.DEVNULL, stdout=proxy_log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
}

async function startDaytonaLiteLlm(
  input: {
    modelId: string;
    reply: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    daytonaExec?: DaytonaExec;
    fetchImpl?: typeof fetch;
  },
  secrets: LiteLlmSecrets,
): Promise<LiteLlmHandle> {
  const exec = input.daytonaExec ?? defaultDaytonaExec;
  const fetchImpl = input.fetchImpl ?? fetch;
  const sandbox = liteLlmSandboxName();
  let root = "";
  let createAttempted = false;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "openwork-litellm-daytona-")));
    const dockerfile = join(root, "Dockerfile");
    await writeFile(dockerfile, DAYTONA_DOCKERFILE, { mode: 0o600 });
    createAttempted = true;
    await checkedExec(
      exec,
      [
        "create",
        "--name", sandbox,
        "--dockerfile", dockerfile,
        "--auto-stop", "60",
        "--auto-delete", "0",
        "--ttl", "120",
        "--public",
        "--target", "us",
      ],
      `LiteLLM sandbox creation gate for ${sandbox}`,
      { timeoutMs: 300_000 },
    );
    await rm(root, { recursive: true, force: true });
    root = "";
    await waitForExecReady(exec, sandbox);

    const config = liteLlmConfig(
      input.modelId,
      `http://127.0.0.1:${DAYTONA_WITNESS_PORT}/v1`,
      secrets.masterKey,
      secrets.upstreamKey,
      input.maxInputTokens,
      input.maxOutputTokens,
    );
    const uploads = [
      ...uploadCommands(config, DAYTONA_CONFIG),
      ...uploadCommands(DAYTONA_WITNESS_SOURCE, DAYTONA_WITNESS),
    ];
    for (const [index, command] of uploads.entries()) {
      await remoteExec(exec, sandbox, command, `LiteLLM upload ${index + 1}/${uploads.length} for ${sandbox}`);
    }
    await remoteExec(exec, sandbox, launchCommand({
      modelId: input.modelId,
      reply: input.reply,
      upstreamTokenId: tokenId(secrets.upstreamKey),
      controlTokenId: tokenId(secrets.controlKey),
    }), `LiteLLM process launch for ${sandbox}`);

    const [gatewayUrl, controlUrl] = await Promise.all([
      previewUrl(exec, sandbox, DAYTONA_PROXY_PORT),
      previewUrl(exec, sandbox, DAYTONA_WITNESS_PORT),
    ]);
    await waitForDaytonaReady(fetchImpl, gatewayUrl, controlUrl, input.modelId, secrets);
    let placementDisposed = false;
    return makeHandle({
      ...secrets,
      baseUrl: `${gatewayUrl}/v1`,
      controlUrl,
      fetchImpl,
      async dispose(): Promise<void> {
        if (placementDisposed) return;
        await deleteSandboxes([sandbox], { exec, log: () => undefined });
        placementDisposed = true;
      },
    });
  } catch (error) {
    const logs = createAttempted
      ? await remoteExec(
        exec,
        sandbox,
        `tail -80 ${DAYTONA_WITNESS_LOG} 2>&1 || true; tail -80 ${DAYTONA_LOG} 2>&1 || true`,
        `LiteLLM failure log capture for ${sandbox}`,
      ).then((result) => `${result.stdout}${result.stderr}`.slice(-4_000), () => "")
      : "";
    if (createAttempted) {
      await deleteSandboxes([sandbox], { exec, log: () => undefined }).catch(() => undefined);
    }
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw redactedError(
      `${messageText(error)}${logs ? `\nDaytona logs:\n${logs}` : ""}`,
      [secrets.masterKey, secrets.upstreamKey, secrets.controlKey],
    );
  }
}

export async function liteLlm(input: {
  place: Place;
  modelId: string;
  reply: string;
  database?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  daytonaExec?: DaytonaExec;
  fetchImpl?: typeof fetch;
}): Promise<LiteLlmHandle> {
  const secrets: LiteLlmSecrets = {
    masterKey: `sk-openwork-master-${randomBytes(24).toString("hex")}`,
    upstreamKey: `sk-openwork-upstream-${randomBytes(24).toString("hex")}`,
    controlKey: `sk-openwork-control-${randomBytes(24).toString("hex")}`,
  };
  if (input.database && input.place.kind === "daytona") {
    throw new SkipError("LiteLLM database mode currently requires docker placement");
  }
  const normalizedInput = {
    ...input,
    maxInputTokens: positiveTokenLimit(input.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS, "maxInputTokens"),
    maxOutputTokens: positiveTokenLimit(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, "maxOutputTokens"),
  };
  return input.place.kind === "daytona"
    ? startDaytonaLiteLlm(normalizedInput, secrets)
    : startLocalLiteLlm(normalizedInput, secrets);
}
