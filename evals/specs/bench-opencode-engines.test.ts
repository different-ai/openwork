import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eventually, test } from "@openwork/testkit";
import { expect } from "vitest";

import {
  createManagedOpencodeServer,
  type ManagedOpencodeServer,
} from "../../apps/server/src/managed-opencode";
import {
  createManagedOpencodeV2Server,
  installOpencodeV2Binary,
  type ManagedOpencodeV2Server,
} from "../../apps/server/src/managed-opencode-v2";

const execFileAsync = promisify(execFile);
const iterations = Number(process.env.OPENWORK_BENCH_ITERATIONS ?? "1");
const pacingMs = 20;
const tokenCount = 20;
const pollIntervalMs = 25;

type Lane = "v1" | "v2";

interface WitnessRequest {
  at: number;
  auth: string;
  model: string;
  promptChars: number;
  messageText: string;
  stream: boolean;
}

interface Witness {
  url: string;
  nonce: string;
  requests: WitnessRequest[];
  close(): Promise<void>;
}

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
}

interface BenchEngine {
  lane: Lane;
  rootDir: string;
  directory: string;
  spawnStartedAt: number;
  bootReadyMs: number;
  list(directory: string): Promise<HttpResult>;
  create(directory: string): Promise<HttpResult>;
  prompt(sessionID: string, directory: string, text: string): Promise<HttpResult>;
  messages(sessionID: string, directory: string): Promise<HttpResult>;
  compact(sessionID: string, directory: string): Promise<HttpResult>;
  close(): Promise<void>;
}

interface MessageTiming {
  accepted: number;
  witnessFirstByte: number;
  firstToken: number;
  complete: number;
}

interface LongMessageTiming {
  accepted: number;
  witnessFirstByte: number;
  complete: number;
}

interface EngineResults {
  boot_ready: number[];
  spawn_to_first_api_ok: number[];
  session_create: number[];
  first_prompt_cold: number[];
  message_rtt: MessageTiming[];
  directory_switch: number[];
  long_message: LongMessageTiming[];
  compaction: number[];
}

interface LaneRun {
  results: EngineResults;
  requests: WitnessRequest[];
}

interface Versions {
  v1: string;
  v2: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readVersions(): Promise<Versions> {
  const constants: unknown = JSON.parse(
    await readFile(join(import.meta.dirname, "../../constants.json"), "utf8"),
  );
  if (
    !isRecord(constants) ||
    typeof constants.opencodeVersion !== "string" ||
    typeof constants.opencodeV2Version !== "string"
  ) {
    throw new Error("constants.json must define opencodeVersion and opencodeV2Version");
  }
  const v1 = constants.opencodeVersion.startsWith("v")
    ? constants.opencodeVersion.slice(1)
    : constants.opencodeVersion;
  return { v1, v2: constants.opencodeV2Version };
}

async function provisionBinary(
  cacheName: string,
  version: string,
  packageName: string,
  binaryName: string,
  overrideName: string,
): Promise<string> {
  const override = process.env[overrideName];
  if (typeof override === "string" && override.trim() !== "") return override;

  if (packageName === "@opencode-ai/cli") {
    return installOpencodeV2Binary(join(tmpdir(), "openwork-opencode-v2-verified"), version);
  }
  const cache = join(tmpdir(), cacheName, version);
  const binary = join(cache, "node_modules", ".bin", binaryName);
  if (!(await exists(binary))) {
    await mkdir(cache, { recursive: true });
    const packageJson = join(cache, "package.json");
    if (!(await exists(packageJson))) await writeFile(packageJson, "{\"private\":true}\n");
    await execFileAsync(
      "pnpm",
      ["add", "--ignore-workspace", "--save-exact", `${packageName}@${version}`],
      { cwd: cache, timeout: 300_000 },
    );
  }
  if (await exists(binary)) {
    try {
      await execFileAsync(binary, ["--version"], { cwd: cache, timeout: 15_000 });
    } catch {
      await execFileAsync("pnpm", ["exec", "node", "postinstall.mjs"], {
        cwd: join(cache, "node_modules", packageName),
        timeout: 300_000,
      });
    }
  }
  if (!(await exists(binary))) {
    throw new Error(
      `${packageName}@${version} did not provide ${binary}; set ${overrideName} to a working binary`,
    );
  }
  return binary;
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

function completionBase(model: string, nonce: string): {
  id: string;
  created: number;
  model: string;
} {
  return {
    id: `chatcmpl-${nonce}`,
    created: Math.floor(Date.now() / 1_000),
    model,
  };
}

async function startWitness(lane: Lane): Promise<Witness> {
  const nonce = `BENCH-${lane}-${randomBytes(12).toString("hex")}`;
  const requests: WitnessRequest[] = [];
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      (request.url !== "/v1/chat/completions" && request.url !== "/chat/completions")
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const at = Date.now();
    try {
      const body = await readRequestBody(request);
      const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
      const messages = isRecord(body) ? body.messages : null;
      const serializedMessages = messages === undefined ? "null" : JSON.stringify(messages);
      const stream = isRecord(body) && body.stream === true;
      requests.push({
        at,
        auth: request.headers.authorization ?? "",
        model,
        promptChars: serializedMessages.length,
        messageText: serializedMessages,
        stream,
      });

      const base = completionBase(model, nonce);
      if (!stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: `## Objective\n${nonce} ${Array.from({ length: tokenCount }, (_, index) => `token ${index + 1} `).join("")}`,
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: `## Objective\n${nonce} ` }, finish_reason: null }],
      })}\n\n`);
      for (let index = 1; index <= tokenCount; index += 1) {
        await sleep(pacingMs);
        response.write(`data: ${JSON.stringify({
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: `token ${index} ` }, finish_reason: null }],
        })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "witness error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`The ${lane} witness failed to bind a TCP port`);
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    nonce,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function fetchJson(
  baseUrl: string,
  authorization: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    directory: string;
    lane: Lane;
  },
): Promise<HttpResult> {
  const url = new URL(path, baseUrl);
  const headers = new Headers({
    authorization,
    "content-type": "application/json",
  });
  if (options.lane === "v1") {
    headers.set("x-opencode-directory", options.directory);
  } else {
    url.searchParams.set("location[directory]", options.directory);
  }
  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let json: unknown = text;
  if (text !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      // Raw engine diagnostics remain available in text.
    }
  }
  return { status: response.status, json, text };
}

function v1Config(witnessUrl: string): unknown {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "bench-witness": {
        npm: "@ai-sdk/openai-compatible",
        name: "Bench Witness",
        options: { baseURL: `${witnessUrl}/v1`, apiKey: "bench-key-v1" },
        models: { "bench-model": { name: "Bench Model" } },
      },
    },
  };
}

function v2Config(witnessUrl: string): unknown {
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      "bench-witness": {
        name: "Bench Witness",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `${witnessUrl}/v1`, apiKey: "bench-key-v2", name: "bench-witness" },
        models: {
          "bench-model": {
            name: "Bench Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
    },
  };
}

function buildEngine(
  lane: Lane,
  rootDir: string,
  directory: string,
  spawnStartedAt: number,
  bootReadyMs: number,
  server: ManagedOpencodeServer | ManagedOpencodeV2Server,
): BenchEngine {
  const authorization = basicAuthorization(server.username, server.password);
  const request = (path: string, options: { method?: string; body?: unknown; directory: string }) =>
    fetchJson(server.url, authorization, path, { ...options, lane });

  return {
    lane,
    rootDir,
    directory,
    spawnStartedAt,
    bootReadyMs,
    list(targetDirectory) {
      return request(lane === "v1" ? "/session" : "/api/session", { directory: targetDirectory });
    },
    create(targetDirectory) {
      const body = lane === "v1"
        ? {
            title: "Engine benchmark",
            model: { providerID: "bench-witness", id: "bench-model" },
          }
        : { model: { providerID: "bench-witness", id: "bench-model" } };
      return request(lane === "v1" ? "/session" : "/api/session", {
        method: "POST",
        body,
        directory: targetDirectory,
      });
    },
    prompt(sessionID, targetDirectory, text) {
      const body = lane === "v1"
        ? {
            model: { providerID: "bench-witness", modelID: "bench-model" },
            parts: [{ type: "text", text }],
          }
        : { text };
      const path = lane === "v1"
        ? `/session/${encodeURIComponent(sessionID)}/prompt_async`
        : `/api/session/${encodeURIComponent(sessionID)}/prompt`;
      return request(path, { method: "POST", body, directory: targetDirectory });
    },
    messages(sessionID, targetDirectory) {
      const path = lane === "v1"
        ? `/session/${encodeURIComponent(sessionID)}/message`
        : `/api/session/${encodeURIComponent(sessionID)}/message`;
      return request(path, { directory: targetDirectory });
    },
    compact(sessionID, targetDirectory) {
      const path = lane === "v1"
        ? `/session/${encodeURIComponent(sessionID)}/summarize`
        : `/api/session/${encodeURIComponent(sessionID)}/compact`;
      const body = lane === "v1"
        ? { providerID: "bench-witness", modelID: "bench-model", auto: false }
        : {};
      return request(path, { method: "POST", body, directory: targetDirectory });
    },
    close: () => server.close(),
  };
}

async function bootEngine(lane: Lane, binary: string, witnessUrl: string): Promise<BenchEngine> {
  const rootDir = await mkdtemp(join(tmpdir(), `bench-opencode-${lane}-`));
  const directory = join(rootDir, "workspace");
  await mkdir(directory);
  try {
    if (lane === "v1") {
      const configPath = join(rootDir, "opencode.json");
      await writeFile(configPath, `${JSON.stringify(v1Config(witnessUrl), null, 2)}\n`);
      const startedAt = Date.now();
      const server = await createManagedOpencodeServer({
        bin: binary,
        cwd: directory,
        timeoutMs: 60_000,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          XDG_CACHE_HOME: join(rootDir, "cache"),
          XDG_CONFIG_HOME: join(rootDir, "xdg-config"),
          XDG_DATA_HOME: join(rootDir, "data"),
          XDG_STATE_HOME: join(rootDir, "state"),
        },
      });
      return buildEngine(lane, rootDir, directory, startedAt, Date.now() - startedAt, server);
    }

    const configDir = join(rootDir, "config");
    await mkdir(configDir);
    await writeFile(
      join(configDir, "opencode.json"),
      `${JSON.stringify(v2Config(witnessUrl), null, 2)}\n`,
    );
    const startedAt = Date.now();
    const server = await createManagedOpencodeV2Server({ bin: binary, rootDir });
    const health = await server.health();
    if (!health.healthy) throw new Error("OpenCode v2 health was not healthy after boot");
    return buildEngine(lane, rootDir, directory, startedAt, Date.now() - startedAt, server);
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function requireStatus(result: HttpResult, expected: number[], operation: string): void {
  if (!expected.includes(result.status)) {
    throw new Error(`${operation} returned HTTP ${result.status}: ${result.text.slice(0, 2_000)}`);
  }
}

function readSessionID(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload.id === "string") return payload.id;
  if (isRecord(payload) && isRecord(payload.data) && typeof payload.data.id === "string") {
    return payload.data.id;
  }
  return undefined;
}

async function createSession(engine: BenchEngine, directory: string): Promise<string> {
  const result = await engine.create(directory);
  requireStatus(result, [200], `${engine.lane} session create`);
  const id = readSessionID(result.json);
  if (id === undefined) {
    throw new Error(`${engine.lane} session create did not return an id: ${result.text.slice(0, 2_000)}`);
  }
  return id;
}

function containsV1Summary(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsV1Summary);
  if (!isRecord(value)) return false;
  if (value.summary === true || value.type === "compaction") return true;
  return Object.values(value).some(containsV1Summary);
}

function containsV2CompletedCompaction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsV2CompletedCompaction);
  if (!isRecord(value)) return false;
  if (value.type === "compaction" && value.status === "completed") return true;
  return Object.values(value).some(containsV2CompletedCompaction);
}

async function waitForMessages(
  engine: BenchEngine,
  sessionID: string,
  directory: string,
  label: string,
  condition: (payload: unknown) => boolean,
  within: number,
): Promise<HttpResult> {
  const result = await eventually(
    () => engine.messages(sessionID, directory),
    {
      within,
      intervalMs: pollIntervalMs,
      label,
      until: (response) => response.status === 200 && condition(response.json),
    },
  );
  requireStatus(result, [200], label);
  return result;
}

async function waitForWitnessRequest(
  witness: Witness,
  startIndex: number,
  label: string,
  within: number,
): Promise<WitnessRequest> {
  const request = await eventually(
    () => witness.requests[startIndex],
    {
      within,
      intervalMs: pollIntervalMs,
      label,
      until: (entry) => entry !== undefined,
    },
  );
  if (request === undefined) throw new Error(`${label} did not reach the witness`);
  return request;
}

async function completePrompt(
  engine: BenchEngine,
  witness: Witness,
  sessionID: string,
  directory: string,
  text: string,
  label: string,
  within: number,
): Promise<MessageTiming> {
  const witnessIndex = witness.requests.length;
  const startedAt = Date.now();
  const accepted = await engine.prompt(sessionID, directory, text);
  requireStatus(accepted, engine.lane === "v1" ? [204] : [200], `${label} prompt admission`);
  const acceptedMs = Date.now() - startedAt;
  const witnessRequest = await waitForWitnessRequest(witness, witnessIndex, `${label} witness request`, within);
  if (!witnessRequest.messageText.includes(text)) {
    throw new Error(`${label} provider request did not contain the complete input (${text.length} characters)`);
  }
  await waitForMessages(
    engine,
    sessionID,
    directory,
    `${label} first token`,
    (payload) => {
      const serialized = JSON.stringify(payload);
      return serialized.includes(witness.nonce) && serialized.includes("token 1 ");
    },
    within,
  );
  const firstTokenMs = Date.now() - startedAt;
  await waitForMessages(
    engine,
    sessionID,
    directory,
    `${label} completion`,
    (payload) => {
      const serialized = JSON.stringify(payload);
      return serialized.includes(witness.nonce) && serialized.includes(`token ${tokenCount} `);
    },
    within,
  );
  return {
    accepted: acceptedMs,
    witnessFirstByte: witnessRequest.at - startedAt,
    firstToken: firstTokenMs,
    complete: Date.now() - startedAt,
  };
}

function longPrompt(): string {
  let value = "";
  let index = 0;
  while (value.length < 200_000) {
    value += `lorem-${index} `;
    index += 1;
  }
  return value.slice(0, 200_000);
}

async function runLane(lane: Lane, binary: string): Promise<LaneRun> {
  const witness = await startWitness(lane);
  const engines: BenchEngine[] = [];
  const extraDirectories: string[] = [];
  const results: EngineResults = {
    boot_ready: [],
    spawn_to_first_api_ok: [],
    session_create: [],
    first_prompt_cold: [],
    message_rtt: [],
    directory_switch: [],
    long_message: [],
    compaction: [],
  };

  try {
    let engine: BenchEngine | undefined;
    for (let index = 0; index < iterations; index += 1) {
      const booted = await bootEngine(lane, binary, witness.url);
      engines.push(booted);
      results.boot_ready.push(booted.bootReadyMs);
      const firstApi = await booted.list(booted.directory);
      requireStatus(firstApi, [200], `${lane} first session-list API`);
      results.spawn_to_first_api_ok.push(Date.now() - booted.spawnStartedAt);
      if (index === iterations - 1) engine = booted;
      else await booted.close();
    }
    if (engine === undefined) throw new Error(`${lane} did not retain a benchmark engine`);

    const scenarioSessions: string[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = Date.now();
      const sessionID = await createSession(engine, engine.directory);
      results.session_create.push(Date.now() - startedAt);
      scenarioSessions.push(sessionID);
    }

    const coldSession = scenarioSessions[0];
    if (coldSession === undefined) throw new Error(`${lane} did not create a cold-prompt session`);
    const coldStartedAt = Date.now();
    await completePrompt(
      engine,
      witness,
      coldSession,
      engine.directory,
      "bench first prompt cold",
      `${lane} first prompt cold`,
      180_000,
    );
    results.first_prompt_cold.push(Date.now() - coldStartedAt);

    // Cold behavior is retained above; this untimed prompt leaves both lanes in the
    // same warm-provider state before the repeatable message scenarios begin.
    const warmupSession = await createSession(engine, engine.directory);
    await completePrompt(
      engine,
      witness,
      warmupSession,
      engine.directory,
      "bench untimed provider warmup",
      `${lane} untimed provider warmup`,
      180_000,
    );

    for (let index = 0; index < iterations; index += 1) {
      const sessionID = await createSession(engine, engine.directory);
      results.message_rtt.push(await completePrompt(
        engine,
        witness,
        sessionID,
        engine.directory,
        `bench message ${index}`,
        `${lane} message RTT ${index}`,
        60_000,
      ));
    }

    for (let index = 0; index < iterations; index += 1) {
      const directory = await mkdtemp(join(tmpdir(), `bench-${lane}-directory-`));
      extraDirectories.push(directory);
      const startedAt = Date.now();
      const listed = await engine.list(directory);
      requireStatus(listed, [200], `${lane} directory switch list ${index}`);
      await createSession(engine, directory);
      results.directory_switch.push(Date.now() - startedAt);
    }

    const prompt = longPrompt();
    const longSessions: string[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const sessionID = await createSession(engine, engine.directory);
      longSessions.push(sessionID);
      const timing = await completePrompt(
        engine,
        witness,
        sessionID,
        engine.directory,
        prompt,
        `${lane} long message ${index}`,
        90_000,
      );
      results.long_message.push({
        accepted: timing.accepted,
        witnessFirstByte: timing.witnessFirstByte,
        complete: timing.complete,
      });
    }

    for (let index = 0; index < longSessions.length; index += 1) {
      const sessionID = longSessions[index];
      if (sessionID === undefined) throw new Error(`${lane} long-message session ${index} is missing`);
      const witnessIndex = witness.requests.length;
      const startedAt = Date.now();
      const compacted = await engine.compact(sessionID, engine.directory);
      requireStatus(compacted, [200], `${lane} compaction ${index}`);
      await waitForMessages(
        engine,
        sessionID,
        engine.directory,
        `${lane} completed compaction ${index}`,
        lane === "v1" ? containsV1Summary : containsV2CompletedCompaction,
        90_000,
      );
      const compactionRequest = await waitForWitnessRequest(
        witness,
        witnessIndex,
        `${lane} compaction witness ${index}`,
        90_000,
      );
      const expectedKey = lane === "v1" ? "bench-key-v1" : "bench-key-v2";
      if (compactionRequest.auth !== `Bearer ${expectedKey}`) {
        throw new Error(`${lane} compaction did not carry its lane key`);
      }
      results.compaction.push(Date.now() - startedAt);
    }

    return { results, requests: witness.requests.map(({ messageText: _text, ...request }) => ({ ...request, messageText: "verified in memory" })) };
  } finally {
    for (const engine of engines) await engine.close();
    await witness.close();
    await Promise.all([
      ...engines.map((engine) => rm(engine.rootDir, { recursive: true, force: true })),
      ...extraDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    ]);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : Math.round((lower + upper) / 2);
}

function medianRows(v1: EngineResults, v2: EngineResults): Array<[string, number, number]> {
  return [
    ["boot_ready", median(v1.boot_ready), median(v2.boot_ready)],
    ["spawn_to_first_api_ok", median(v1.spawn_to_first_api_ok), median(v2.spawn_to_first_api_ok)],
    ["session_create", median(v1.session_create), median(v2.session_create)],
    ["first_prompt_cold", median(v1.first_prompt_cold), median(v2.first_prompt_cold)],
    ["message.accepted", median(v1.message_rtt.map((sample) => sample.accepted)), median(v2.message_rtt.map((sample) => sample.accepted))],
    ["message.witness_first_byte", median(v1.message_rtt.map((sample) => sample.witnessFirstByte)), median(v2.message_rtt.map((sample) => sample.witnessFirstByte))],
    ["message.first_token", median(v1.message_rtt.map((sample) => sample.firstToken)), median(v2.message_rtt.map((sample) => sample.firstToken))],
    ["message.complete", median(v1.message_rtt.map((sample) => sample.complete)), median(v2.message_rtt.map((sample) => sample.complete))],
    ["directory_switch", median(v1.directory_switch), median(v2.directory_switch)],
    ["long.accepted", median(v1.long_message.map((sample) => sample.accepted)), median(v2.long_message.map((sample) => sample.accepted))],
    ["long.witness_first_byte", median(v1.long_message.map((sample) => sample.witnessFirstByte)), median(v2.long_message.map((sample) => sample.witnessFirstByte))],
    ["long.complete", median(v1.long_message.map((sample) => sample.complete)), median(v2.long_message.map((sample) => sample.complete))],
    ["compaction", median(v1.compaction), median(v2.compaction)],
  ];
}

function assertFiniteSamples(values: number[], expected: number): void {
  expect(values).toHaveLength(expected);
  expect(values.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
}

function assertCompleted(results: EngineResults): void {
  assertFiniteSamples(results.boot_ready, iterations);
  assertFiniteSamples(results.spawn_to_first_api_ok, iterations);
  assertFiniteSamples(results.session_create, iterations);
  assertFiniteSamples(results.first_prompt_cold, 1);
  expect(results.message_rtt).toHaveLength(iterations);
  expect(results.message_rtt.every((sample) =>
    [sample.accepted, sample.witnessFirstByte, sample.firstToken, sample.complete]
      .every((value) => Number.isFinite(value) && value >= 0))).toBe(true);
  assertFiniteSamples(results.directory_switch, iterations);
  expect(results.long_message).toHaveLength(iterations);
  expect(results.long_message.every((sample) =>
    [sample.accepted, sample.witnessFirstByte, sample.complete]
      .every((value) => Number.isFinite(value) && value >= 0))).toBe(true);
  assertFiniteSamples(results.compaction, iterations);
}

test("benchmarks OpenCode v1 and v2 engines with identical client sequences", async ({ evidence }) => {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("OPENWORK_BENCH_ITERATIONS must be a positive integer");
  }

  const versions = await readVersions();
  const v1Binary = await provisionBinary(
    "openwork-opencode-v1-cache",
    versions.v1,
    "opencode-ai",
    "opencode",
    "OPENWORK_EVAL_OPENCODE_BIN_V1",
  );
  const v2Binary = await provisionBinary(
    "openwork-opencode-v2-cache",
    versions.v2,
    "@opencode-ai/cli",
    "opencode2",
    "OPENWORK_EVAL_OPENCODE2_BIN",
  );

  const v1 = await runLane("v1", v1Binary);
  const v2 = await runLane("v2", v2Binary);
  assertCompleted(v1.results);
  assertCompleted(v2.results);

  const laneAssertions: Array<{
    lane: Lane;
    run: LaneRun;
    expectedKey: string;
    wrongKey: string;
  }> = [
    { lane: "v1", run: v1, expectedKey: "bench-key-v1", wrongKey: "bench-key-v2" },
    { lane: "v2", run: v2, expectedKey: "bench-key-v2", wrongKey: "bench-key-v1" },
  ];
  for (const { lane, run, expectedKey, wrongKey } of laneAssertions) {
    expect(run.requests.length).toBeGreaterThan(0);
    expect(run.requests.every((request) => request.auth === `Bearer ${expectedKey}`)).toBe(true);
    expect(run.requests.every((request) => request.model === "bench-model")).toBe(true);
    expect(run.requests.every((request) => request.promptChars > 0)).toBe(true);
    expect(run.requests.some((request) => request.auth === `Bearer ${wrongKey}`)).toBe(false);
    evidence.recordAssertionEvidence(
      `${lane} engine benchmark completion and witness fidelity`,
      `${lane} completed boot, API readiness, create, cold prompt, warm RTT, directory switch, 200k message, and compaction samples; every witness request used only Bearer ${expectedKey} with bench-model.`,
      true,
    );
  }

  const cpu = cpus();
  const resultsDir = process.env.OPENWORK_BENCH_RESULTS_DIR ?? tmpdir();
  await mkdir(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `bench-opencode-engines-${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify({
    lane: "engines",
    createdAt: new Date().toISOString(),
    machine: {
      platform: platform(),
      arch: arch(),
      cpus: cpu.length,
      cpuModel: cpu[0]?.model ?? "unknown",
      memGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      node: process.version,
    },
    versions,
    iterations,
    pacingMs,
    tokens: tokenCount,
    results: { v1: v1.results, v2: v2.results },
  }, null, 2)}\n`);

  const table = medianRows(v1.results, v2.results)
    .map(([scenario, v1Median, v2Median]) => `${scenario}\t${v1Median}\t${v2Median}`)
    .join("\n");
  console.info(`[bench-opencode-engines] medians (ms)\nscenario\tv1\tv2\n${table}\nresults\t${outputPath}`);
}, 600_000);
