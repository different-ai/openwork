import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, mcpMock, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

import {
  createManagedOpencodeV2Server,
  installOpencodeV2Binary,
  type ManagedOpencodeV2Server,
} from "../../apps/server/src/managed-opencode-v2";
import { resolveOpencodeModelsUrl } from "../../apps/server/src/opencode-models-url";


interface WitnessRequest {
  at: number;
  auth: string;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


async function resolveOpencodeV2Bin(): Promise<string> {
  const override = process.env.OPENWORK_EVAL_OPENCODE2_BIN;
  if (typeof override === "string" && override.trim() !== "") return override;

  const constants: unknown = JSON.parse(await readFile(join(import.meta.dirname, "../../constants.json"), "utf8"));
  if (!isRecord(constants) || typeof constants.opencodeV2Version !== "string") {
    throw new Error("constants.json must define a string opencodeV2Version");
  }
  return installOpencodeV2Binary(join(tmpdir(), "openwork-opencode-v2-verified"), constants.opencodeV2Version);
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

function sessionId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  return typeof payload.data.id === "string" ? payload.data.id : undefined;
}

// Complements the real HTTP proxy + fake readiness cases in opencode-proxy.e2e:
// this crosses the pinned native engine's storage boundary, not the proxy gate.
test("V2-STORED-01: cold stored reads survive pending catalog and MCP readiness", { timeout: 60_000 }, async ({ evidence, place }) => {
  needs({ placement: "local", env: ["OPENWORK_EVAL_OPENCODE2_BIN"] });
  const binary = process.env.OPENWORK_EVAL_OPENCODE2_BIN;
  if (!binary) throw new Error("A pre-cached native-v2 binary is required; this case never installs one");
  expect((await stat(binary)).isFile()).toBe(true);
  const rootDir = await mkdtemp(join(tmpdir(), "oc2-stored-reads-"));
  const directory = join(rootDir, "workspace");
  const foreignDirectory = join(rootDir, "foreign-workspace");
  const home = join(rootDir, "home");
  const env = {
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
    OPENCODE_CONFIG: join(rootDir, "fixture.json"),
  };
  await Promise.all([directory, foreignDirectory, ...Object.values(env).filter((path) => path !== env.OPENCODE_CONFIG)]
    .map((path) => mkdir(path, { recursive: true })));
  // The managed launcher allowlists OS variables and accepts only explicit
  // OPENCODE_CONFIG/MODELS_URL; inherited OPENCODE_*, credentials and DB paths
  // cannot enter this child. HOME, XDG paths, config and DB are fixture-owned.
  const { handle: mcp } = await mcpMock({ allowUnauthenticatedMcp: true, isolatedProcessEnv: true, tools: [] }).boot(place);
  const catalogPending = new Set<ServerResponse>();
  const mcpPending = new Set<ServerResponse>();
  const unexpected: string[] = [];
  let providerRequests = 0;
  let server: ManagedOpencodeV2Server | undefined;
  const hold = (pending: Set<ServerResponse>, response: ServerResponse) => {
    pending.add(response);
    response.once("close", () => pending.delete(response));
  };
  // mcpMock owns the protocol; this loopback fault holds its initialize reply.
  // Neither gate is released before the stored-read assertions finish.
  const witness = createServer(async (request, response) => {
    try {
      if (request.url === "/seed/api.json") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (request.url === "/cold/api.json") {
        hold(catalogPending, response);
        return;
      }
      if (request.url?.split("?")[0] === "/mcp") {
        const body = request.method === "POST" ? await readRequestBody(request) : undefined;
        const reply = await fetch(mcp.mcpUrl, {
          method: request.method,
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(3_000),
        });
        const text = await reply.text();
        if (isRecord(body) && body.method === "initialize" && reply.ok) {
          hold(mcpPending, response);
          return;
        }
        response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" }).end(text);
        return;
      }
      if (request.url?.startsWith("/provider/")) providerRequests += 1;
      else unexpected.push(`${request.method} ${request.url}`);
      response.writeHead(503).end();
    } catch {
      unexpected.push("witness forwarding failed");
      response.writeHead(500).end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      witness.once("error", reject);
      witness.listen(0, "127.0.0.1", resolve);
    });
    const address = witness.address();
    if (address === null || typeof address === "string") throw new Error("Stored-read witness did not bind");
    const witnessUrl = `http://127.0.0.1:${address.port}`;
    const model = { providerID: "stored-read-witness", id: "stored-model" };
    const config = {
      providers: {
        [model.providerID]: {
          package: "@opencode-ai/ai/providers/openai-compatible",
          settings: { baseURL: `${witnessUrl}/provider/v1`, apiKey: "fixture-only" },
          models: { [model.id]: { name: "Stored model", limit: { context: 4096, output: 512 } } },
        },
      },
    };
    await writeFile(env.OPENCODE_CONFIG, JSON.stringify(config));
    server = await createManagedOpencodeV2Server({
      bin: binary, rootDir, bootTimeoutMs: 10_000,
      env: { ...env, OPENCODE_MODELS_URL: `${witnessUrl}/seed` },
    });
    const firstHealth = await server.health();
    expect(firstHealth.version).toBe("0.0.0-beta-19086");
    const time = 1_700_000_000_000;
    const transcript = (id: string, workspace: string, marker: string) => ({
      location: { directory: workspace },
      info: {
        id, projectID: "global", title: marker, location: { directory: workspace },
        agent: "build", model, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: time, updated: time + 2, idle: time + 2 }, outcome: "succeeded",
        metadata: { fixture: marker },
      },
      messages: [
        { id: `msg_${marker}_user`, type: "user", text: `Stored question ${marker}`, time: { created: time } },
        { id: `msg_${marker}_answer`, type: "assistant", agent: "build", model,
          content: [{ type: "text", text: `Stored answer ${marker}` }], finish: "stop",
          time: { created: time + 1, completed: time + 2 } },
      ],
    });
    const owned = transcript("ses_stored_owner", directory, "owner");
    const foreign = transcript("ses_stored_foreign", foreignDirectory, "foreign");
    const imported = [];
    for (const body of [owned, foreign]) {
      const result = await server.fetchJson("/api/session/import", { method: "POST", body, timeoutMs: 3_000 });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      expect(result.json).toMatchObject({ data: { id: body.info.id, location: body.location, metadata: body.info.metadata } });
      imported.push(result.json);
    }
    await server.close();
    expect(server.exitCode).not.toBeNull();
    const database = await stat(join(rootDir, "opencode.db"));
    expect(database.size).toBeGreaterThan(0);
    await writeFile(env.OPENCODE_CONFIG, JSON.stringify({ ...config, mcp: { servers: {
      "pending-witness": { type: "remote", url: `${witnessUrl}/mcp`, oauth: false, timeout: { startup: 30_000 } },
    } } }));
    // Same DB, new process and catalog source key: no prior location runtime or
    // catalog cache can satisfy this cold startup. The launcher waits on health only.
    server = await createManagedOpencodeV2Server({
      bin: binary, rootDir, bootTimeoutMs: 10_000,
      env: { ...env, OPENCODE_MODELS_URL: `${witnessUrl}/cold` },
    });
    const health = await server.health();
    expect(health.version).toBe("0.0.0-beta-19086");
    expect(health.pid).toBe(server.childPid);
    expect(health.pid).not.toBe(firstHealth.pid);
    expect((await stat(join(rootDir, "opencode.db"))).ino).toBe(database.ino);
    // Start location-dependent readiness, never a prompt. Observe the actual
    // native requests reaching the held witnesses rather than relying on sleep.
    const catalogSnapshot = await server.fetchJson("/api/model", { directory, timeoutMs: 15_000 });
    expect(catalogSnapshot.status).toBe(200);
    await eventually(() => ({ catalog: catalogPending.size, mcp: mcpPending.size, unexpected }), {
      within: 5_000, intervalMs: 20, label: "native catalog and MCP initialization at local gates",
      until: (state) => state.catalog > 0 && state.mcp > 0,
    });
    const assertPending = async () => {
      const nativeMcp = await server!.fetchJson("/api/mcp", { directory, timeoutMs: 1_000 });
      expect(nativeMcp.status).toBe(200);
      expect(nativeMcp.json).toMatchObject({ data: [{ name: "pending-witness", status: { status: "pending" } }] });
      expect(catalogPending.size).toBeGreaterThan(0);
      expect(mcpPending.size).toBeGreaterThan(0);
      expect(providerRequests).toBe(0);
      expect(unexpected).toEqual([]);
    };
    await assertPending();
    const timings: Record<string, number> = {};
    const read = async (label: string, path: string) => {
      await assertPending();
      const start = Date.now();
      const result = await server!.fetchJson(path, { directory, timeoutMs: 1_000 });
      timings[label] = Date.now() - start;
      await assertPending();
      return result;
    };
    const metadata = await read("metadata", `/api/session/${owned.info.id}`);
    expect(metadata.status).toBe(200);
    expect(metadata.json).toEqual(imported[0]);
    // Small settled transcript only: this does not prove the adapter paginates >50.
    const messages = await read("messages", `/api/session/${owned.info.id}/message?order=asc&limit=10`);
    expect(messages.status).toBe(200);
    expect(messages.json).toMatchObject({ data: owned.messages });
    if (!isRecord(messages.json) || !Array.isArray(messages.json.data)) throw new Error("Missing native message list");
    expect(messages.json.data).toHaveLength(2);
    const single = await read("single", `/api/session/${owned.info.id}/message/${owned.messages[1].id}`);
    expect(single.status).toBe(200);
    expect(single.json).toEqual({ data: owned.messages[1] });
    const foreignExists = await read("foreign-owner", `/api/session/${foreign.info.id}/message/${foreign.messages[1].id}`);
    expect(foreignExists.status).toBe(200);
    expect(foreignExists.json).toEqual({ data: foreign.messages[1] });
    const refused = await read("foreign-refused", `/api/session/${owned.info.id}/message/${foreign.messages[1].id}`);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.json)).not.toContain("Stored answer foreign");
    expect(server.exitCode).toBeNull();
    evidence.recordAssertionEvidence(
      "V2-STORED-01 native cold storage reads before location readiness",
      `Native version ${health.version}; seed PID ${firstHealth.pid}, cold PID ${health.pid}, child PID ${server.childPid}; placement ${place.kind}. Cold-restarted the same isolated DB after HTTP import. Exact metadata, two settled messages and single-message reads completed within 1s each while catalog/MCP replies remained held and the native MCP status remained pending; /api/model returned its nonblocking snapshot. A foreign message existed under its owner but returned 404 under the other session. Provider requests: 0. Read timings (ms): ${JSON.stringify(timings)}. Direct native boundary only; proxy gate and >50 adapter pagination are not exercised.`,
      true,
    );
  } finally {
    await server?.close();
    for (const response of [...catalogPending, ...mcpPending]) response.destroy();
    witness.closeAllConnections();
    await new Promise<void>((resolve) => witness.close(() => resolve()));
    await mcp.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("opencode v2 injects providers at runtime without an engine reload", { timeout: 240_000 }, async ({ evidence }) => {
  const binary = await resolveOpencodeV2Bin();
  const nonce = `WITNESS-OK-${randomBytes(12).toString("hex")}`;
  const requests: WitnessRequest[] = [];
  let impersonatorRequests = 0;
  const witness = createServer(async (request, response) => {
    if (request.url === "/api/health") {
      impersonatorRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "fake", pid: process.pid }));
      return;
    }
    if (request.method !== "POST" || (request.url !== "/v1/chat/completions" && request.url !== "/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    try {
      const body = await readRequestBody(request);
      const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
      requests.push({ at: Date.now(), auth: request.headers.authorization ?? "", model });
      const chunks = [
        { id: "chatcmpl-w", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: "chatcmpl-w", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: nonce }, finish_reason: null }] },
        { id: "chatcmpl-w", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      console.error(error);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "witness error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    witness.once("error", reject);
    witness.listen(0, "127.0.0.1", resolve);
  });
  const witnessAddress = witness.address();
  if (witnessAddress === null || typeof witnessAddress === "string") throw new Error("Witness failed to bind a TCP port");
  const witnessUrl = `http://127.0.0.1:${witnessAddress.port}`;
  const rootDir = await mkdtemp(join(tmpdir(), "oc2-hot-inject-"));
  // The engine shares this machine's package cache on purpose: a cold cache makes
  // the first prompt install the provider SDK from the registry (minutes, network-
  // bound, and the v2 prompt call blocks for all of it). Cold-cache catalog
  // readiness is proven by engine-v2-preview-flag.e2e.test.ts from a fresh sandbox.
  const directory = join(rootDir, "workspace");
  await mkdir(directory);
  const baseConfig = join(rootDir, "opencode.json");
  await writeFile(baseConfig, `${JSON.stringify({ agent: { openwork: { mode: "primary" } }, default_agent: "openwork" })}\n`);
  let server: ManagedOpencodeV2Server | undefined;

  try {
    const opencodeModelsUrl = await resolveOpencodeModelsUrl();
    let occupiedPortRejected = false;
    try {
      const impostor = await createManagedOpencodeV2Server({
        bin: binary, rootDir: join(rootDir, "occupied-port"), port: witnessAddress.port,
        bootTimeoutMs: 10_000,
        env: { OPENCODE_CONFIG: baseConfig, OPENCODE_MODELS_URL: opencodeModelsUrl },
      });
      await impostor.close();
    } catch {
      occupiedPortRejected = true;
    }
    expect(occupiedPortRejected).toBe(true);
    expect(impersonatorRequests).toBe(0);
    evidence.recordAssertionEvidence(
      "an occupied port cannot impersonate the sidecar or receive its credential",
      "A pre-bound fake healthy listener caused startup to reject; it received zero health requests. The normal boot below uses the child-announced OS-assigned port.",
      true,
    );
    const catalogStartedAt = Date.now();
    server = await createManagedOpencodeV2Server({
      bin: binary,
      rootDir,
      env: {
        OPENCODE_CONFIG: baseConfig, OPENCODE_MODELS_URL: opencodeModelsUrl,
        OPENWORK_ENCRYPTION_KEY: "fixture-server-only", OPENWORK_TOKEN: "fixture-server-only",
        OPENWORK_HOST_TOKEN: "fixture-server-only", OPENWORK_SERVER_TOKEN: "fixture-server-only",
        OPENWORK_POLICY_TOKEN: "fixture-server-only",
        OPENAI_API_KEY: "fixture-server-only", ANTHROPIC_API_KEY: "fixture-server-only",
        AWS_SECRET_ACCESS_KEY: "fixture-server-only", GITHUB_TOKEN: "fixture-server-only",
        DATABASE_URL: "fixture-server-only", CUSTOM_SERVICE_SECRET: "fixture-server-only",
      },
    });
    const initialHealth = await server.health();
    const pid0 = initialHealth.pid;
    expect(initialHealth.healthy).toBe(true);
    expect(pid0).toBe(server.childPid);
    expect(Number(new URL(server.url).port)).toBeGreaterThan(0);
    if (process.platform === "linux") {
      const environment = await readFile(`/proc/${pid0}/environ`, "utf8");
      const names = environment.split("\0").map((entry) => entry.split("=")[0]);
      expect(names.filter((name) => name?.startsWith("OPENWORK_"))).toEqual([]);
      for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "DATABASE_URL", "CUSTOM_SERVICE_SECRET"]) {
        expect(names).not.toContain(name);
      }
      expect(names).toContain("PATH");
      evidence.recordAssertionEvidence(
        "server credentials do not cross the sidecar process boundary",
        "The live Linux sidecar retained PATH but contained none of the synthetic policy, control-plane, provider, cloud, database, or arbitrary service credentials supplied through spawn options. Unknown environment keys were not inherited.",
        true,
      );
    }

    const running = server;
    const baseline = await eventually(
      () => running.fetchJson("/api/model", { directory }),
      {
        within: 60_000,
        intervalMs: 250,
        label: "cold model catalog to initialize",
        until: (result) => result.status === 200,
      },
    );
    const catalogReadinessMs = Date.now() - catalogStartedAt;
    const baselineText = JSON.stringify(baseline.json);
    expect(baseline.status).toBe(200);
    expect(baselineText).not.toContain("openwork-witness-a");
    expect(baselineText).not.toContain("openwork-witness-b");
    console.info(`[opencode-v2-spec] cold catalog readiness: ${catalogReadinessMs}ms`);
    evidence.recordAssertionEvidence(
      "C1 positive baseline and negative provider absence",
      `The freshly booted v2 engine listed models after ${catalogReadinessMs}ms while containing neither witness A nor witness B before injection. The package cache is shared; this is not cold-cache installation proof.`,
      true,
    );

    const injectionStartedAt = Date.now();
    await server.injectProvider({
      id: "openwork-witness-a",
      name: "Witness A",
      baseUrl: `${witnessUrl}/v1`,
      apiKey: "witness-key-a",
      models: [{ id: "witness-model-a", name: "Witness Model A" }],
    });
    const modelsAfterA = await eventually(
      () => server?.fetchJson("/api/model", { directory }),
      {
        within: 15_000,
        intervalMs: 250,
        label: "provider A to appear in the model list",
        until: (result) => result !== undefined && JSON.stringify(result.json).includes("openwork-witness-a"),
      },
    );
    if (process.platform !== "win32") {
      for (const path of [rootDir, join(rootDir, "config"), join(rootDir, "config", "opencode.json")]) {
        expect((await stat(path)).mode & 0o077).toBe(0);
      }
      evidence.recordAssertionEvidence(
        "mirrored provider credentials are readable only by their owner",
        "The sidecar root, config directory, and provider file have no group or other-user permission bits after live provider injection.",
        true,
      );
    }
    const injectionLatencyMs = Date.now() - injectionStartedAt;
    expect(JSON.stringify(modelsAfterA?.json)).toContain("openwork-witness-a");
    console.info(`[opencode-v2-spec] provider A injection latency: ${injectionLatencyMs}ms`);
    evidence.recordAssertionEvidence(
      "C2 positive hot injection and negative bounded-wait failure",
      `Witness A appeared through the watched config in ${injectionLatencyMs}ms, within the 15s bound and without a startup operation.`,
      true,
    );

    const sessionA = await server.fetchJson("/api/session", {
      method: "POST",
      directory,
      body: { model: { providerID: "openwork-witness-a", id: "witness-model-a" } },
    });
    expect(sessionA.status).toBe(200);
    const idA = sessionId(sessionA.json);
    expect(idA).toBeTypeOf("string");
    if (idA === undefined) throw new Error("Provider A session response did not contain data.id");
    const shellProbe = join(directory, "policy-boundary.cjs");
    await writeFile(shellProbe, `console.log(JSON.stringify({ policy: Object.hasOwn(process.env, "OPENWORK_POLICY_TOKEN"), client: Object.hasOwn(process.env, "OPENWORK_SERVER_TOKEN"), ipc: typeof process.send === "function" }));\n`);
    // The engine's login shell can replace PATH. Use the test runner's Node,
    // rather than an unrelated system install, for this presence-only probe.
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(shellProbe)}`;
    const shell = await server.fetchJson(`/api/session/${idA}/shell`, {
      method: "POST", directory, body: { command }, timeoutMs: 15_000,
    });
    expect(shell.status).toBe(204);
    const shellMessages = await server.fetchJson(`/api/session/${idA}/message`, { directory });
    const shellMessage: unknown = isRecord(shellMessages.json) && Array.isArray(shellMessages.json.data)
      ? shellMessages.json.data.find((message: unknown) => isRecord(message) && message.type === "shell" && message.command === command)
      : undefined;
    expect(shellMessage, JSON.stringify(shellMessage)).toMatchObject({ status: "exited", exit: 0 });
    if (!isRecord(shellMessage) || !isRecord(shellMessage.output) || typeof shellMessage.output.output !== "string") {
      throw new Error("The policy boundary shell probe did not return output");
    }
    expect(JSON.parse(shellMessage.output.output.trim())).toEqual({ policy: false, client: false, ipc: false });
    evidence.recordAssertionEvidence(
      "shell execution cannot inherit the host policy credential or IPC channel",
      "The real v2 shell completed a presence-only probe: neither policy nor client credentials nor a process IPC capability were inherited.",
      true,
    );
    const promptA = await server.fetchJson(`/api/session/${idA}/prompt`, {
      method: "POST",
      directory,
      body: { text: "reply with anything" },
    });
    expect(promptA.status).toBe(200);
    await eventually(
      async () => JSON.stringify((await server?.fetchJson(`/api/session/${idA}/message`, { directory }))?.json),
      { within: 60_000, intervalMs: 250, label: "provider A witness response", until: (text) => text.includes(nonce) },
    );
    expect(requests.some((entry) => entry.auth === "Bearer witness-key-a" && entry.model === "witness-model-a")).toBe(true);
    expect(requests.some((entry) => entry.model === "witness-model-b")).toBe(false);
    evidence.recordAssertionEvidence(
      "C3 positive provider A execution and negative wrong-credential routing",
      "The A session received the witness nonce, and the witness observed model A paired with only the expected Bearer key A assertion.",
      true,
    );
    await server.injectProvider({
      id: "openwork-witness-b",
      name: "Witness B",
      baseUrl: `${witnessUrl}/v1`,
      apiKey: "witness-key-b",
      models: [{ id: "witness-model-b", name: "Witness Model B" }],
    });
    let providerBFirstSeenAt: number | undefined;
    const modelsAfterB = await eventually(
      () => server?.fetchJson("/api/model", { directory }),
      {
        within: 15_000,
        intervalMs: 250,
        label: "provider B to appear in the model list",
        until: (result) => {
          if (result === undefined || !JSON.stringify(result.json).includes("openwork-witness-b")) {
            providerBFirstSeenAt = undefined;
            return false;
          }
          providerBFirstSeenAt ??= Date.now();
          return Date.now() - providerBFirstSeenAt >= 2_000;
        },
      },
    );
    const modelsAfterBText = JSON.stringify(modelsAfterB?.json);
    expect(modelsAfterBText).toContain("openwork-witness-a");
    expect(modelsAfterBText).toContain("openwork-witness-b");

    const sessionB = await server.fetchJson("/api/session", {
      method: "POST",
      directory,
      body: { model: { providerID: "openwork-witness-b", id: "witness-model-b" } },
    });
    expect(sessionB.status).toBe(200);
    const idB = sessionId(sessionB.json);
    expect(idB).toBeTypeOf("string");
    if (idB === undefined) throw new Error("Provider B session response did not contain data.id");
    const promptB = await server.fetchJson(`/api/session/${idB}/prompt`, {
      method: "POST",
      directory,
      body: { text: "reply with anything" },
    });
    expect(promptB.status).toBe(200);
    // Direct engine prompts no longer run the removed managed model hook.
    // Server request admission and Den model authorization are separate journeys.
    await eventually(
      async () => JSON.stringify((await server?.fetchJson(`/api/session/${idB}/message`, { directory }))?.json),
      { within: 60_000, intervalMs: 250, label: "provider B witness response", until: (text) => text.includes(nonce) },
    );
    expect(requests.some((entry) => entry.auth === "Bearer witness-key-b" && entry.model === "witness-model-b")).toBe(true);
    expect(requests.some((entry) => entry.auth === "Bearer witness-key-a" && entry.model === "witness-model-b")).toBe(false);
    evidence.recordAssertionEvidence(
      "C5 positive warm re-injection and negative clobbering or key leakage",
      "Both providers remained listed; B produced the nonce with key B/model B, while no key A/model B request occurred.",
      true,
    );

    const finalHealth = await server.health();
    expect(finalHealth.pid).toBe(pid0);
    expect(server.exitCode).toBeNull();
    expect((server.stdout.match(/server listening on/g) ?? []).length).toBe(1);
    evidence.recordAssertionEvidence(
      "C4 positive same-process health and negative engine replacement",
      `Health retained pid ${pid0}, the child remained live, and stdout contained exactly one server-listening boot line after both injections.`,
      true,
    );
  } finally {
    if (server !== undefined) await server.close();
    await new Promise<void>((resolve, reject) => witness.close((error) => error ? reject(error) : resolve()));
    await rm(rootDir, { recursive: true, force: true });
  }
});
