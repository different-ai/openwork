import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_PATH,
  DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH,
  MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_CHAT_PATH, desktopFreeSessionPowMessage, leadingZeroBits,
  type DesktopFreeAccessStatus,
} from "@openwork/free-auto";
import { AnonymousInferenceService, isOwnedProvider } from "./anonymous-inference.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import { EnvService } from "./env-file.js";
import { readGlobalRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy } from "./runtime-opencode-config-store.js";
import type { DesktopFreeSigner, ServerConfig } from "./types.js";
import { openworkRuntimeConfigFilePath } from "./openwork-runtime-config.js";

const ready: DesktopFreeAccessStatus = {
  state: "ready", code: null, currentVersion: "0.20.0", minimumVersion: "0.20.0",
  providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID,
  allowance: { limitUsd: 1, usedUsd: 0.2, reservedUsd: 0, remainingUsd: 0.8, resetsAt: "2030-01-07T00:00:00Z" },
};
const memberReady: DesktopFreeAccessStatus = { ...ready, allowance: { ...ready.allowance!, limitUsd: 5, remainingUsd: 4.8 } };
const credentialPath = "/api/den/v1/inference/free/credential";
const rawChat = '{ "model": "openai/gpt-5.6-luna", "messages": [] }';
const memberKey = (session: CloudProviderDenSession) => `ow_inf_${createHash("sha256").update(`${session.token === "fixture-session-refreshed" ? "fixture-session" : session.token}:${session.orgId}`).digest("base64url")}`;

function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type ObservedRequest = { path: string; method: string; headers: Headers; body: string };

async function fixture(run: (input: {
  service: AnonymousInferenceService; config: ServerConfig; env: EnvService; envPath: string;
  environment: NodeJS.ProcessEnv; memberSession: CloudProviderDenSession; origin: string;
  requests: ObservedRequest[]; signed: Parameters<DesktopFreeSigner["sign"]>[0][];
  reject: (path: string, status: number, payload: unknown, headers?: HeadersInit) => void;
  rejectOnce: (path: string, status: number, payload: unknown) => void;
  sessionPowBits: (body: string, proof: Parameters<DesktopFreeSigner["sign"]>[0] | undefined, rounds?: number) => number;
  localRequest: (endpoint?: string, body?: string, sessionID?: string) => Promise<Request>;
  connectMember: () => Promise<void>;
  /** What the app does when the user presses send with Auto selected. */
  activate: (sessionID?: string) => Promise<void>;
  endSession: (sessionID?: string, how?: "abort" | "delete") => Promise<void>;
  advance: (ms: number) => void;
  pauseCredential: () => { started: Promise<void>; release: () => void };
}) => Promise<void>, native = true, environmentOverrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "openwork-free-inference-"));
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const requests: ObservedRequest[] = [];
  const signed: Parameters<DesktopFreeSigner["sign"]>[0][] = [];
  const rejected = new Map<string, { status: number; payload: unknown; headers?: HeadersInit }>();
  const keys = new Set<string>();
  const releases: Array<() => void> = [];
  let credentialGate: { entered: ReturnType<typeof latch>; released: ReturnType<typeof latch> } | null = null;
  const observe = async (request: Request) => {
    const observation = { path: new URL(request.url).pathname, method: request.method, headers: request.headers, body: await request.text() };
    requests.push(observation);
    expect(request.headers.get("cookie")).toBe(null);
    return observation;
  };
  const rejectedOnce = new Map<string, { status: number; payload: unknown }>();
  const rejection = (path: string) => {
    const once = rejectedOnce.get(path);
    if (once) { rejectedOnce.delete(path); return Response.json(once.payload, { status: once.status }); }
    const value = rejected.get(path);
    return value ? Response.json(value.payload, { status: value.status, headers: value.headers }) : null;
  };
  const machineId = "c".repeat(64);
  // How much work the relay did for this mint: bits over the machine id and the nonce it asked the signer to use.
  const sessionPowBits = (body: string, proof: Parameters<DesktopFreeSigner["sign"]>[0] | undefined, rounds?: number) => {
    const pow = (JSON.parse(body) as { pow?: unknown }).pow;
    if (typeof pow !== "string" || typeof proof?.nonce !== "string") return -1;
    const solutions = pow.split(".");
    if (solutions.length !== (rounds ?? solutions.length)) return -1;
    const nonce = proof.nonce;
    return Math.min(...solutions.map((solution, round) => leadingZeroBits(createHash("sha256").update(desktopFreeSessionPowMessage({ machineId, nonce, round, pow: solution })).digest())));
  };
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { path, headers, method, body } = await observe(request);
    const proofIndex = Number(headers.get("x-openwork-desktop-proof")?.replace("proof-", "")) - 1;
    const proof = signed[proofIndex];
    expect(proof?.path).toBe(path);
    expect(proof?.method).toBe(method);
    expect(proof?.authorization).toBe(headers.get("authorization") ?? "");
    expect(new TextDecoder().decode(proof?.body)).toBe(body);
    expect(headers.get("x-openwork-desktop-token")).toBe(null);
    const failed = rejection(path);
    if (failed) return failed;
    if (path === DESKTOP_FREE_SESSION_PATH) {
      expect(headers.has("authorization")).toBe(false);
      expect(sessionPowBits(body, proof)).toBeGreaterThanOrEqual(8);
      return Response.json({ token: "guest-fixture", expiresAt: Date.now() + 300_000, model: DESKTOP_FREE_MODEL_ID });
    }
    const member = [MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_CHAT_PATH].includes(path);
    if (member) expect(keys.has(headers.get("authorization") ?? "")).toBe(true);
    else expect(headers.get("authorization")).toBe("Bearer guest-fixture");
    if (path === DESKTOP_FREE_STATUS_PATH || path === MEMBER_FREE_STATUS_PATH) return Response.json(member ? memberReady : ready);
    if (path === DESKTOP_FREE_MODELS_PATH || path === MEMBER_FREE_MODELS_PATH) return Response.json({ data: [{ id: DESKTOP_FREE_MODEL_ID }] });
    if (path === DESKTOP_FREE_CHAT_PATH || path === MEMBER_FREE_CHAT_PATH) return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return new Response(null, { status: 404 });
  } });
  const origin = gateway.url.origin;
  const den = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { path, headers, method, body } = await observe(request);
    expect([credentialPath, "/alternate-den/v1/inference/free/credential"]).toContain(path);
    expect(method).toBe("POST");
    expect(body).toBe("");
    expect(headers.get("x-openwork-desktop-proof")).toBe(null);
    expect(headers.get("x-openwork-org-id")).toBe(headers.get("x-openwork-legacy-org-id"));
    expect(headers.get("authorization")?.startsWith("Bearer fixture-")).toBe(true);
    const gate = credentialGate;
    credentialGate = null;
    if (gate) { gate.entered.resolve(); await gate.released.promise; }
    const failed = rejection(path);
    if (failed) return failed;
    const apiKey = memberKey({ baseUrl: new URL(request.url).origin, token: headers.get("authorization")!.slice(7), orgId: headers.get("x-openwork-org-id")! });
    keys.add(`Bearer ${apiKey}`);
    return Response.json({ credential: { apiKey, baseURL: `${origin}/api/v1`, statusURL: `${origin}${MEMBER_FREE_STATUS_PATH}`, modelID: DESKTOP_FREE_MODEL_ID } });
  } });
  const memberSession = { baseUrl: `${den.url.origin}/api/den`, orgId: "fixture-org", token: "fixture-session" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 9876, token: "client-token", hostToken: "owner-token",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    ...(native ? { anonymousInference: { desktop: {
      currentVersion: "0.20.0",
      identity: async () => ({ machineId, publicKey: "fixture-public-key", appVersion: "0.20.0", platform: "darwin", arch: "arm64" }),
      sign: async (request) => { signed.push(request); return `proof-${signed.length}`; },
    } satisfies DesktopFreeSigner } } : {}),
  };
  const envPath = join(root, "env.json");
  const env = new EnvService({ path: envPath });
  const environment = { NODE_ENV: "test", OPENWORK_FREE_INFERENCE_ORIGIN: origin, OPENWORK_FREE_SESSION_POW_BITS: "8", OPENWORK_FREE_SESSION_POW_ROUNDS: "2", OPENWORK_FREE_HEARTBEAT_MS: "0", ...environmentOverrides };
  let clock = Date.now();
  const service = new AnonymousInferenceService(config, { log: () => {} }, environment, () => clock);
  try {
    await run({ service, config, env, envPath, environment, memberSession, origin, requests, signed,
      reject: (path, status, payload, headers) => { rejected.set(path, { status, payload, headers }); },
      rejectOnce: (path, status, payload) => { rejectedOnce.set(path, { status, payload }); },
      sessionPowBits,
      connectMember: () => service.setMemberSession(memberSession),
      activate: (sessionID = "test") => service.assertTaskAccess(new Request(`http://localhost/session/${sessionID}/prompt_async`, { method: "POST",
        body: JSON.stringify({ model: { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID } }) }), `/session/${sessionID}/prompt_async`),
      endSession: (sessionID = "test", how = "abort") => service.assertTaskAccess(new Request(`http://localhost/session/${sessionID}${how === "abort" ? "/abort" : ""}`,
        { method: how === "abort" ? "POST" : "DELETE" }), `/session/${sessionID}${how === "abort" ? "/abort" : ""}`),
      advance: (ms) => { clock += ms; },
      pauseCredential: () => {
        const entered = latch();
        const released = latch();
        releases.push(released.resolve);
        credentialGate = { entered, released };
        return { started: entered.promise, release: released.resolve };
      },
      localRequest: async (endpoint = "chat/completions", body = rawChat, sessionID?: string) => {
        const runtime = await readGlobalRuntimeOpencodeConfig(config);
        const provider = runtime.provider?.[DESKTOP_FREE_PROVIDER_ID];
        if (!provider || typeof provider !== "object" || !("options" in provider)) throw new Error("Missing fixture provider");
        const options = provider.options;
        if (!options || typeof options !== "object" || !("apiKey" in options) || typeof options.apiKey !== "string") throw new Error("Missing fixture local key");
        return new Request(`http://127.0.0.1:9876/anonymous-inference/v1/${endpoint}`, {
          method: endpoint === "models" ? "GET" : "POST", headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", ...(sessionID ? { "x-openwork-session-id": sessionID } : {}) },
          ...(endpoint === "models" ? {} : { body }),
        });
      },
    });
  } finally {
    service.stop();
    for (const release of releases) release();
    await den.stop(true);
    await gateway.stop(true);
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

test("standalone server cannot enroll using browser headers or a client token", async () => {
  await fixture(async ({ service, config, requests, connectMember }) => {
    expect(await service.initialize(9876)).toBe(false);
    await connectMember();
    expect((await service.status(true)).state).toBe("unavailable");
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toBeUndefined();
    const response = await service.handle(new Request("http://localhost/anonymous-inference/v1/models", {
      headers: { authorization: "Bearer client-token", "user-agent": "OpenWork Desktop" },
    }), "models");
    expect(response.status).toBe(401);
    expect(requests).toHaveLength(0);
  }, false);
});

test("native enrollment is lazy and preserves explicit providers and defaults; BYOK admission never contacts Cloud", async () => {
  await fixture(async ({ service, config, requests, signed, localRequest, connectMember, activate }) => {
    const paid = { name: "Explicit provider", options: { apiKey: "fixture" } };
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ default_agent: "custom", provider: { paid } }));
    expect(await service.initialize(9876)).toBe(true);
    expect(requests).toHaveLength(0);
    const prompt = new Request("http://localhost/session/test/prompt_async", { method: "POST", body: JSON.stringify({ model: { providerID: "paid", modelID: "chosen" } }) });
    await service.assertTaskAccess(prompt, "/session/test/prompt_async");
    await connectMember();
    await service.assertTaskAccess(prompt.clone(), "/opencode2/api/session/test/prompt");
    expect(requests).toHaveLength(0);
    await service.setMemberSession(null);
    await activate();
    const response = await service.handle(await localRequest(), "chat/completions");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(signed.at(-1)?.path).toBe(DESKTOP_FREE_CHAT_PATH);
    expect(new TextDecoder().decode(signed.at(-1)?.body)).toBe(rawChat);
    const runtime = await readGlobalRuntimeOpencodeConfig(config);
    expect(runtime.provider?.paid).toEqual(paid);
    expect(runtime.default_agent).toBe("custom");
    expect(JSON.stringify(runtime)).not.toContain("guest-fixture");
    expect(isOwnedProvider(runtime.provider?.[DESKTOP_FREE_PROVIDER_ID])).toBe(true);
    // The engine talks plain OpenAI Chat Completions to the relay; no OpenRouter adapter.
    const owned = runtime.provider?.[DESKTOP_FREE_PROVIDER_ID] as Record<string, unknown>;
    expect(owned.npm).toBe("@ai-sdk/openai-compatible");
    expect(isOwnedProvider({ ...owned, npm: "@openrouter/ai-sdk-provider" })).toBe(false);
  });
});

test("HTTP exchange switches guest to member, caches only in memory, and invalidates on logout, relogin, org, token and base URL changes", async () => {
  await fixture(async ({ service, config, env, envPath, memberSession, requests, signed, localRequest, connectMember, activate }) => {
    await env.upsertMany([{ key: "OPENWORK_API_KEY", value: "ow_inf_unrelated_paid_fixture" }]);
    const beforeEnv = await readFile(envPath, "utf8");
    const reads = spyOn(EnvService.prototype, "list");
    try {
      await service.initialize(9876);
      expect((await service.status()).allowance?.limitUsd).toBe(1);
      await connectMember();
      expect((await service.status()).allowance?.limitUsd).toBe(5);
      expect((await service.handle(await localRequest("models"), "models")).status).toBe(200);
      await activate();
      const response = await service.handle(await localRequest(), "chat/completions");
      expect(await response.text()).toContain("[DONE]");
      expect(signed.at(-1)?.path).toBe(MEMBER_FREE_CHAT_PATH);
      expect(signed.at(-1)?.authorization).toBe(`Bearer ${memberKey(memberSession)}`);
      expect(new TextDecoder().decode(signed.at(-1)?.body)).toBe(rawChat);
      expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(1);
      expect(JSON.stringify(await service.status())).not.toContain("ow_inf_");
      expect(JSON.stringify(await readGlobalRuntimeOpencodeConfig(config))).not.toContain("ow_inf_");
      await service.setMemberSession(null);
      expect((await service.status()).allowance?.limitUsd).toBe(1);
      await connectMember();
      expect((await service.status(true)).allowance?.limitUsd).toBe(5);
      for (const session of [{ ...memberSession, orgId: "fixture-other-org" }, { ...memberSession, token: "fixture-other-principal" }, { ...memberSession, baseUrl: `${memberSession.baseUrl}/` }]) {
        await service.setMemberSession(session);
        expect((await service.status(true)).state).toBe("ready");
        expect(signed.at(-1)?.authorization).toBe(`Bearer ${memberKey(session)}`);
      }
      expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(5);
      expect(reads).not.toHaveBeenCalled();
      expect(await readFile(envPath, "utf8")).toBe(beforeEnv);
    } finally { reads.mockRestore(); }
  });
});

test("relay credentials fence tool continuations across guest, org, authority and logout transitions; reloaded config admits fresh tasks", async () => {
  await fixture(async ({ service, config, memberSession, requests, localRequest, activate }) => {
    await service.initialize(9876);
    let previousRequest = await localRequest();
    await activate();
    expect(await (await service.handle(previousRequest.clone(), "chat/completions")).text()).toContain("[DONE]");
    for (const next of [memberSession, { ...memberSession, orgId: "fixture-switched-org" },
      { ...memberSession, baseUrl: memberSession.baseUrl.replace("/api/den", "/alternate-den") }, null]) {
      const before = requests.length;
      await service.setMemberSession(next);
      const stale = await service.handle(previousRequest.clone(), "chat/completions");
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ error: { code: "invalid_local_anonymous_token" } });
      expect(requests).toHaveLength(before);
      const freshRequest = await localRequest();
      expect(freshRequest.headers.get("authorization")).not.toBe(previousRequest.headers.get("authorization"));
      const engineConfig: unknown = JSON.parse(await readFile(openworkRuntimeConfigFilePath(config), "utf8"));
      expect(engineConfig).toMatchObject({ provider: { [DESKTOP_FREE_PROVIDER_ID]: {
        options: { apiKey: freshRequest.headers.get("authorization")!.slice(7) },
      } } });
      await activate();
      expect(await (await service.handle(freshRequest.clone(), "chat/completions")).text()).toContain("[DONE]");
      previousRequest = freshRequest;
    }
  });
});

test("same session is stable and refreshed bearers retain the relay token only after Den confirms the same principal", async () => {
  await fixture(async ({ service, memberSession, requests, localRequest, connectMember, activate }) => {
    await service.initialize(9876);
    await connectMember();
    expect((await service.status(true)).state).toBe("ready");
    await activate();
    const task = await localRequest();
    await service.setMemberSession({ token: memberSession.token, orgId: memberSession.orgId, baseUrl: `${memberSession.baseUrl}/` });
    expect((await localRequest()).headers.get("authorization")).toBe(task.headers.get("authorization"));
    expect(await (await service.handle(task.clone(), "chat/completions")).text()).toContain("[DONE]");
    expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(1);

    await service.setMemberSession({ ...memberSession, token: "fixture-session-refreshed" });
    const beforeRefresh = requests.length;
    expect((await service.handle(task.clone(), "chat/completions")).status).toBe(409);
    expect(requests).toHaveLength(beforeRefresh);
    expect((await service.status(true)).state).toBe("ready");
    expect((await localRequest()).headers.get("authorization")).toBe(task.headers.get("authorization"));
    expect(await (await service.handle(task.clone(), "chat/completions")).text()).toContain("[DONE]");
    expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(2);

    await service.setMemberSession({ ...memberSession, token: "fixture-other-principal" });
    const beforeSwitch = requests.length;
    expect((await service.handle(task.clone(), "chat/completions")).status).toBe(409);
    expect(requests).toHaveLength(beforeSwitch);
    expect((await service.status(true)).state).toBe("ready");
    const afterVerification = requests.length;
    expect((await service.handle(task.clone(), "chat/completions")).status).toBe(401);
    expect(requests).toHaveLength(afterVerification);
    expect((await localRequest()).headers.get("authorization")).not.toBe(task.headers.get("authorization"));
    await activate();
    expect(await (await service.handle(await localRequest(), "chat/completions")).text()).toContain("[DONE]");
  });
});

test("rapid switches publish only the current relay credential and preserve explicit provider edits", async () => {
  await fixture(async ({ service, config, memberSession, requests, localRequest, activate }) => {
    await service.initialize(9876);
    const previousRequest = await localRequest();
    await Promise.all([
      service.setMemberSession(memberSession),
      service.setMemberSession({ ...memberSession, orgId: "fixture-final-org" }),
    ]);
    expect((await service.handle(previousRequest, "chat/completions")).status).toBe(401);
    expect(requests).toHaveLength(0);
    await activate();
    expect(await (await service.handle(await localRequest(), "chat/completions")).text()).toContain("[DONE]");
    expect(requests.find((request) => request.path === credentialPath)?.headers.get("x-openwork-org-id")).toBe("fixture-final-org");
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current,
      provider: { ...current.provider, [DESKTOP_FREE_PROVIDER_ID]: { userNote: "explicit provider" } },
    }));
    await service.setMemberSession(null);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toEqual({ userNote: "explicit provider" });
    expect((await service.status()).state).toBe("unavailable");
  });
});

test("credential exchange coalesces concurrent status calls and is reacquired after controller restart", async () => {
  await fixture(async ({ service, config, environment, memberSession, requests, connectMember, pauseCredential }) => {
    await service.initialize(9876);
    await connectMember();
    const gate = pauseCredential();
    const first = service.status(true);
    await gate.started;
    const second = service.status(true);
    gate.release();
    expect((await first).state).toBe("ready");
    expect((await second).state).toBe("ready");
    expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(1);
    const restarted = new AnonymousInferenceService(config, { log: () => {} }, environment);
    try {
      await restarted.initialize(9876);
      await restarted.setMemberSession(memberSession);
      expect((await restarted.status(true)).allowance?.limitUsd).toBe(5);
      expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(2);
      expect(requests.some((request) => request.path.startsWith("/api/anonymous"))).toBe(false);
    } finally { restarted.stop(); }
  });
});

test("credential exchange cancellation cannot cache an old principal after logout or org switch", async () => {
  await fixture(async ({ service, memberSession, requests, connectMember, pauseCredential }) => {
    await service.initialize(9876);
    for (const next of [null, { ...memberSession, orgId: "fixture-switched-org" }]) {
      await service.setMemberSession(null);
      await connectMember();
      const before = requests.length;
      const gate = pauseCredential();
      const pending = service.status(true);
      await gate.started;
      await service.setMemberSession(next);
      gate.release();
      expect((await pending).state).toBe("unavailable");
      expect(requests.slice(before).map((request) => request.path)).toEqual([credentialPath]);
      expect((await service.status(true)).allowance?.limitUsd).toBe(next ? 5 : 1);
      if (next) expect(requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${memberKey(next)}`);
    }
  });
});

test("a policy change during credential exchange prevents caching and gateway dispatch", async () => {
  await fixture(async ({ service, config, requests, connectMember, pauseCredential }) => {
    await service.initialize(9876);
    await connectMember();
    const gate = pauseCredential();
    const pending = service.status(true);
    await gate.started;
    await writeManagedDesktopPolicy(config, { allowCustomProviders: false });
    gate.release();
    expect((await pending).state).toBe("unavailable");
    expect(requests.map((request) => request.path)).toEqual([credentialPath]);
    await writeManagedDesktopPolicy(config, { allowCustomProviders: true });
    await service.initialize(9876);
    expect((await service.status(true)).state).toBe("ready");
    expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(2);
  });
});

test("Den disabled, denied, missing, malformed and redirect responses never become readiness or guest fallback", async () => {
  await fixture(async ({ service, env, requests, localRequest, connectMember, reject, memberSession }) => {
    await service.initialize(9876);
    await connectMember();
    await env.upsertMany([{ key: "OPENWORK_API_KEY", value: "ow_inf_should_not_rescue_free" }]);
    for (const [status, payload] of [[401, { error: "unauthorized" }], [403, { error: "forbidden" }], [503, { error: "free_disabled" }], [503, { error: "managed_models_policy_unavailable" }], [404, {}], [200, { credential: null }], [200, { error: "ow_inf_must_not_escape" }]] satisfies [number, unknown][]) {
      reject(credentialPath, status, payload);
      const result = await service.status(true);
      expect(result.state).toBe("unavailable");
      if (status === 503 && typeof payload === "object" && payload && "error" in payload) expect(result.code).toBe(payload.error);
      expect(JSON.stringify(result)).not.toContain("ow_inf_must_not_escape");
      expect((await service.handle(await localRequest(), "chat/completions")).ok).toBe(false);
    }
    reject(credentialPath, 307, {}, { location: `${memberSession.baseUrl}/unexpected` });
    expect((await service.status(true)).state).toBe("unavailable");
    expect(requests.every((request) => request.path === credentialPath)).toBe(true);
  });
});

test("member credentials reject foreign origins, wrong paths, query strings, model changes and non-Models keys before gateway dispatch", async () => {
  await fixture(async ({ service, origin, memberSession, requests, connectMember, reject }) => {
    await service.initialize(9876);
    await connectMember();
    const credential = { apiKey: memberKey(memberSession), baseURL: `${origin}/api/v1`, statusURL: `${origin}${MEMBER_FREE_STATUS_PATH}`, modelID: DESKTOP_FREE_MODEL_ID };
    for (const changed of [
      { baseURL: `${memberSession.baseUrl}/api/v1` },
      { statusURL: `${memberSession.baseUrl}${MEMBER_FREE_STATUS_PATH}` },
      { baseURL: `${origin}/api/free/v1` }, { statusURL: `${credential.statusURL}?next=other` },
      { baseURL: `${origin}/other/../api/v1` }, { modelID: "paid/model" },
      { apiKey: "ow_inf_short" }, { apiKey: `ow_auto_${"a".repeat(43)}` }, { apiKey: `ow_gw_${"a".repeat(43)}` },
    ]) {
      reject(credentialPath, 200, { credential: { ...credential, ...changed } });
      expect((await service.status(true)).code).toBe("member_free_credentials_unavailable");
    }
    expect(requests.every((request) => request.path === credentialPath)).toBe(true);
  });
});

test("gateway member auth, policy and exhaustion failures do not fall back to guest or use a guest enrollment token", async () => {
  await fixture(async ({ service, requests, localRequest, connectMember, reject, activate }) => {
    await service.initialize(9876);
    await connectMember();
    await activate();
    reject(DESKTOP_FREE_SESSION_PATH, 503, { error: { code: "anonymous_unavailable" } });
    for (const [status, code] of [[401, "invalid_free_member_key"], [403, "free_principal_rejected"], [429, "anonymous_limit_exceeded"]] satisfies [number, string][]) {
      reject(MEMBER_FREE_CHAT_PATH, status, { error: { code } });
      await service.status(true);
      const response = await service.handle(await localRequest(), "chat/completions");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code } });
    }
    expect(requests.filter((request) => request.path === credentialPath)).toHaveLength(3);
    for (const [status, code] of [[401, "invalid_free_member_key"], [403, "free_principal_rejected"], [429, "anonymous_limit_exceeded"]] satisfies [number, string][]) {
      reject(MEMBER_FREE_STATUS_PATH, status, { error: { code } });
      const before = requests.length;
      expect((await service.status(true)).state).toBe(status === 429 ? "exhausted" : "unavailable");
      expect((await service.handle(await localRequest(), "chat/completions")).ok).toBe(false);
      expect(requests.slice(before).some((request) => request.path === MEMBER_FREE_CHAT_PATH)).toBe(false);
    }
    expect(requests.some((request) => request.path.startsWith("/api/anonymous"))).toBe(false);
  });
});

test("an identity change during signing cancels dispatch rather than retrying as guest", async () => {
  await fixture(async ({ service, config, memberSession, requests, localRequest, connectMember, activate }) => {
    await service.initialize(9876);
    await connectMember();
    await activate();
    const mark = requests.length;
    const desktop = config.anonymousInference?.desktop;
    if (!desktop) throw new Error("Missing native fixture");
    const sign = desktop.sign;
    desktop.sign = async (request) => {
      const proof = await sign(request);
      if (request.path === MEMBER_FREE_CHAT_PATH) await service.setMemberSession({ ...memberSession, orgId: "fixture-switched-org" });
      return proof;
    };
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(503);
    expect(requests.slice(mark).map((request) => request.path)).toEqual([MEMBER_FREE_STATUS_PATH]);
  });
});

test("latest-version preflight blocks only free selection and gateway rejection is preserved", async () => {
  await fixture(async ({ service, requests, localRequest, reject, activate }) => {
    await service.initialize(9876);
    expect((await service.status()).state).toBe("ready");
    await activate();
    reject(DESKTOP_FREE_STATUS_PATH, 426, { error: { code: "desktop_update_required", minimumVersion: "0.21.0" } });
    const prompt = new Request("http://localhost/session/test/prompt_async", { method: "POST", body: JSON.stringify({ model: { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID } }) });
    await expect(service.assertTaskAccess(prompt, "/session/test/prompt_async")).rejects.toMatchObject({ status: 426, code: "desktop_update_required" });
    await expect(service.assertTaskAccess(prompt.clone(), "/opencode2/api/session/test/prompt")).rejects.toMatchObject({ status: 426, code: "desktop_update_required" });
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(426);
    expect(requests.some((request) => request.path === DESKTOP_FREE_CHAT_PATH)).toBe(false);
    reject(DESKTOP_FREE_STATUS_PATH, 200, ready);
    reject(DESKTOP_FREE_CHAT_PATH, 426, { error: { code: "desktop_update_required", minimumVersion: "0.22.0" } });
    const response = await service.handle(await localRequest(), "chat/completions");
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ error: { minimumVersion: "0.22.0" } });
  });
});

test("local disable and policy denial prevent credential issuance, and user provider edits remain untouched", async () => {
  await fixture(async ({ service, config, environment, requests, localRequest, connectMember }) => {
    const disabled = new AnonymousInferenceService(config, { log: () => {} }, { ...environment, OPENWORK_DISABLE_FREE_INFERENCE: "1" });
    disabled.setMemberSession({ baseUrl: "https://api.openworklabs.com", token: "fixture-disabled", orgId: "fixture-org" });
    expect(await disabled.initialize(9876)).toBe(false);
    expect((await disabled.status(true)).state).toBe("unavailable");
    disabled.stop();
    await service.initialize(9876);
    await connectMember();
    const request = await localRequest();
    await writeManagedDesktopPolicy(config, { allowCustomProviders: false });
    expect((await service.handle(request, "chat/completions")).status).toBe(403);
    expect(requests).toHaveLength(0);
    await service.initialize(9876);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toBeUndefined();
    await writeManagedDesktopPolicy(config, { allowCustomProviders: true });
    await service.initialize(9876);
    const runtime = await readGlobalRuntimeOpencodeConfig(config);
    const original = runtime.provider?.[DESKTOP_FREE_PROVIDER_ID];
    const edited = { ...(typeof original === "object" ? original : {}), userNote: "explicit choice" };
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, provider: { ...current.provider, [DESKTOP_FREE_PROVIDER_ID]: edited } }));
    expect(await service.initialize(9877)).toBe(false);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toEqual(edited);
    expect((await service.status()).state).toBe("unavailable");
  });
});

test("local relay refuses oversized or non-free requests before enrollment", async () => {
  await fixture(async ({ service, requests, localRequest, connectMember, activate }) => {
    await service.initialize(9876);
    await connectMember();
    await activate();
    const mark = requests.length;
    expect((await service.handle(await localRequest("chat/completions", '{"model":"paid/model"}'), "chat/completions")).status).toBe(400);
    expect((await service.handle(await localRequest("chat/completions", "x".repeat(2 * 1024 * 1024 + 1)), "chat/completions")).status).toBe(413);
    expect(requests.slice(mark)).toHaveLength(0);
  });
});

test("the engine cannot spend Auto until the user sends with Auto selected; models and status stay reachable", async () => {
  await fixture(async ({ service, requests, localRequest, activate }) => {
    await service.initialize(9876);
    const before = requests.length;
    const blocked = await service.handle(await localRequest(), "chat/completions");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: "auto_not_activated" } });
    expect(requests.filter((request) => request.path === DESKTOP_FREE_CHAT_PATH)).toHaveLength(0);
    expect((await service.handle(await localRequest("models"), "models")).status).toBe(200);
    expect((await service.status(true)).state).toBe("ready");
    const paidPrompt = new Request("http://localhost/session/test/prompt_async", { method: "POST", body: JSON.stringify({ model: { providerID: "paid", modelID: "chosen" } }) });
    await service.assertTaskAccess(paidPrompt, "/session/test/prompt_async");
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(403);
    await activate();
    expect(await (await service.handle(await localRequest(), "chat/completions")).text()).toContain("[DONE]");
    expect(requests.length).toBeGreaterThan(before);
  });
});

test("activation follows the task: it idles out after 15 minutes without completed calls, refreshes on each one, and caps at 2 hours", async () => {
  await fixture(async ({ service, localRequest, activate, advance }) => {
    await service.initialize(9876);
    await activate();
    advance(14 * 60_000);
    expect(await (await service.handle(await localRequest(), "chat/completions")).text()).toContain("[DONE]");
    advance(14 * 60_000);
    // Only a completed call refreshes the window: an unread stream does not.
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(200);
    advance(14 * 60_000);
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(403);
    await activate();
    for (let minutes = 0; minutes < 120; minutes += 10) {
      advance(10 * 60_000);
      const response = await service.handle(await localRequest(), "chat/completions");
      expect(response.status).toBe(minutes + 10 >= 120 ? 403 : 200);
      if (response.ok) await response.text();
    }
  });
});

test("ending a session closes its activation only when no other Auto task is live; identity changes and stop close it outright", async () => {
  await fixture(async ({ service, localRequest, activate, endSession, connectMember }) => {
    await service.initialize(9876);
    await activate("one");
    await activate("two");
    await endSession("one", "abort");
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(200);
    await endSession("two", "delete");
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(403);
    await activate("three");
    await connectMember();
    // Signing in closed the guest activation.
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(403);
    await activate("four");
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(200);
    service.stop();
    expect((await service.handle(await localRequest(), "chat/completions")).status).not.toBe(200);
  });
});

test("an engine call that names its session must name one the user started", async () => {
  await fixture(async ({ service, localRequest, activate }) => {
    await service.initialize(9876);
    await activate("mine");
    expect((await service.handle(await localRequest("chat/completions", rawChat, "mine"), "chat/completions")).status).toBe(200);
    const foreign = await service.handle(await localRequest("chat/completions", rawChat, "someone-elses"), "chat/completions");
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "auto_not_activated" } });
    // An engine that sends no session header still works inside the window.
    expect((await service.handle(await localRequest(), "chat/completions")).status).toBe(200);
  });
});

test("the first guest session uses work started while the app loaded, and the next session's work starts right after", async () => {
  await fixture(async ({ service, requests, signed, sessionPowBits, activate, localRequest }) => {
    await service.initialize(9876);
    const warmed = service.warmSessionPow("c".repeat(64));
    await warmed.ready;
    await activate();
    expect(await (await service.handle(await localRequest(), "chat/completions")).text()).toContain("[DONE]");
    const mint = requests.findIndex((request) => request.path === DESKTOP_FREE_SESSION_PATH);
    expect(signed[mint]?.nonce).toBe(warmed.nonce);
    expect(sessionPowBits(requests[mint].body, signed[mint])).toBeGreaterThanOrEqual(8);
    const next = service.warmSessionPow("c".repeat(64));
    expect(next.nonce).not.toBe(warmed.nonce);
    await next.ready;
  });
});

test("minting a guest session does the proof of work for its own nonce and redoes it once if the gateway wants more", async () => {
  await fixture(async ({ service, requests, signed, rejectOnce, sessionPowBits, activate, localRequest }) => {
    await service.initialize(9876);
    rejectOnce(DESKTOP_FREE_SESSION_PATH, 400, { error: { code: "session_pow_required", bits: 10, rounds: 3 } });
    await activate();
    expect(await (await service.handle(await localRequest(), "chat/completions")).text()).toContain("[DONE]");
    const mints = requests.map((request, index) => ({ request, proof: signed[index] })).filter(({ request }) => request.path === DESKTOP_FREE_SESSION_PATH);
    expect(mints).toHaveLength(2);
    expect(sessionPowBits(mints[0].request.body, mints[0].proof, 2)).toBeGreaterThanOrEqual(8);
    expect(sessionPowBits(mints[1].request.body, mints[1].proof, 3)).toBeGreaterThanOrEqual(10);
    expect(mints[0].proof?.nonce).not.toBe(mints[1].proof?.nonce);
    // A demand beyond the supported maximum is not honoured.
    rejectOnce(DESKTOP_FREE_SESSION_PATH, 400, { error: { code: "session_pow_required", bits: 40 } });
    await service.setMemberSession({ baseUrl: "https://den.example.test", orgId: "o", token: "t" });
    await service.setMemberSession(null);
    expect((await service.status(true)).state).toBe("unavailable");
  });
});

test("a switched-off guest gateway is not asked again, and no proof of work is solved, until its refusal lapses or someone sends with Auto", async () => {
  await fixture(async ({ service, requests, reject, advance, activate }) => {
    await service.initialize(9876);
    reject(DESKTOP_FREE_SESSION_PATH, 503, { error: { code: "anonymous_unavailable" } });
    const mints = () => requests.filter((request) => request.path === DESKTOP_FREE_SESSION_PATH).length;
    expect((await service.status(true)).code).toBe("anonymous_unavailable");
    expect(mints()).toBe(1);
    for (let beat = 0; beat < 5; beat++) {
      advance(60_000);
      expect((await service.status(true)).code).toBe("anonymous_unavailable");
    }
    expect((await service.status()).state).toBe("unavailable");
    expect(mints()).toBe(1);
    advance(10 * 60_000);
    await service.status(true);
    expect(mints()).toBe(2);
    // A send with Auto selected asks straight away.
    await activate().catch(() => undefined);
    expect(mints()).toBe(3);
  });
});

test("while the app is open and signed out, the relay sends a signed status heartbeat so active time accrues", async () => {
  await fixture(async ({ service, requests, connectMember }) => {
    await service.initialize(9876);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const beats = requests.filter((request) => request.path === DESKTOP_FREE_STATUS_PATH).length;
    expect(beats).toBeGreaterThanOrEqual(2);
    await connectMember();
    const afterSignIn = requests.filter((request) => request.path === DESKTOP_FREE_STATUS_PATH).length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests.filter((request) => request.path === DESKTOP_FREE_STATUS_PATH).length).toBe(afterSignIn);
    service.stop();
  }, true, { OPENWORK_FREE_HEARTBEAT_MS: "60" });
});
