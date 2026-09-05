import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, test } from "@openwork/testkit";
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

test("opencode v2 injects providers at runtime without an engine reload", { timeout: 240_000 }, async ({ evidence }) => {
  const binary = await resolveOpencodeV2Bin();
  const nonce = `WITNESS-OK-${randomBytes(12).toString("hex")}`;
  const requests: WitnessRequest[] = [];
  const witness = createServer(async (request, response) => {
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
    const catalogStartedAt = Date.now();
    server = await createManagedOpencodeV2Server({
      bin: binary,
      rootDir,
      env: {
        OPENCODE_CONFIG: baseConfig, OPENCODE_MODELS_URL: opencodeModelsUrl,
        OPENWORK_ENCRYPTION_KEY: "fixture-server-only", OPENWORK_TOKEN: "fixture-server-only",
        OPENWORK_HOST_TOKEN: "fixture-server-only", OPENWORK_SERVER_TOKEN: "fixture-server-only",
      },
    });
    const initialHealth = await server.health();
    const pid0 = initialHealth.pid;
    expect(initialHealth.healthy).toBe(true);
    if (process.platform === "linux") {
      const environment = await readFile(`/proc/${pid0}/environ`, "utf8");
      const names = environment.split("\0").map((entry) => entry.split("=")[0]);
      expect(names.filter((name) => name?.startsWith("OPENWORK_"))).toEqual([]);
      evidence.recordAssertionEvidence(
        "server credentials do not cross the sidecar process boundary",
        "The live Linux sidecar environment contained no OPENWORK_ variables, including four synthetic server credentials supplied through spawn options.",
        true,
      );
    }

    const baseline = await eventually(
      () => server?.fetchJson("/api/model", { directory }),
      {
        within: 60_000,
        intervalMs: 250,
        label: "cold model catalog to initialize",
        until: (result) => result?.status === 200,
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
      `The cold-cache v2 engine listed models after ${catalogReadinessMs}ms while containing neither witness A nor witness B before injection.`,
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
