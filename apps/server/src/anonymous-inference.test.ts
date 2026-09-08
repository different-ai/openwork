import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_PATH,
  DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH,
  type DesktopFreeAccessStatus,
} from "@openwork/types/desktop-free-access";
import { AnonymousInferenceService, isOwnedProvider } from "./anonymous-inference.js";
import { readGlobalRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy } from "./runtime-opencode-config-store.js";
import type { DesktopFreeSigner, ServerConfig } from "./types.js";

const ready: DesktopFreeAccessStatus = {
  state: "ready", code: null, currentVersion: "0.20.0", minimumVersion: "0.20.0",
  providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID,
  allowance: { limitUsd: 1, usedUsd: 0.2, reservedUsd: 0, remainingUsd: 0.8, resetsAt: "2026-09-14T00:00:00Z" },
};

async function fixture(run: (input: {
  service: AnonymousInferenceService; config: ServerConfig; root: string;
  requests: { path: string; init?: RequestInit }[];
  signed: Parameters<DesktopFreeSigner["sign"]>[0][];
  reject: (path: string, status: number, payload: unknown) => void;
  localRequest: (endpoint?: string) => Promise<Request>;
}) => Promise<void>, native = true) {
  const root = await mkdtemp(join(tmpdir(), "openwork-free-inference-"));
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const requests: { path: string; init?: RequestInit }[] = [];
  const signed: Parameters<DesktopFreeSigner["sign"]>[0][] = [];
  const rejected = new Map<string, { status: number; payload: unknown }>();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, init });
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("x-openwork-desktop-proof")).toBe(`proof-${signed.length}`);
    const rejection = rejected.get(path);
    if (rejection) return Response.json(rejection.payload, { status: rejection.status });
    if (path === DESKTOP_FREE_SESSION_PATH) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ token: "remote-bearer-never-in-engine", expiresAt: Date.now() + 300_000, model: DESKTOP_FREE_MODEL_ID });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer remote-bearer-never-in-engine");
    if (path === DESKTOP_FREE_STATUS_PATH) return Response.json(ready);
    if (path === DESKTOP_FREE_MODELS_PATH) return Response.json({ data: [{ id: DESKTOP_FREE_MODEL_ID }] });
    if (path === DESKTOP_FREE_CHAT_PATH) return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    throw new Error("Unexpected fixture gateway request");
  }, { preconnect: () => {} }));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 9876, token: "client-token", hostToken: "owner-token",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    ...(native ? { anonymousInference: { desktop: {
      currentVersion: "0.20.0",
      identity: async () => ({ installationId: "798c02f8-c4f0-4c39-81b7-91e2281d122c", publicKey: "fixture-public-key", appVersion: "0.20.0", platform: "darwin", arch: "arm64" }),
      sign: async (request) => { signed.push(request); return `proof-${signed.length}`; },
    } satisfies DesktopFreeSigner } } : {}),
  };
  const service = new AnonymousInferenceService(config, { log: () => {} }, { NODE_ENV: "test" });
  try {
    await run({ service, config, root, requests, signed,
      reject: (path, status, payload) => { rejected.set(path, { status, payload }); },
      localRequest: async (endpoint = "chat/completions") => {
        const runtime = await readGlobalRuntimeOpencodeConfig(config);
        const provider = runtime.provider?.[DESKTOP_FREE_PROVIDER_ID];
        if (!provider || typeof provider !== "object" || !("options" in provider)) throw new Error("Missing fixture provider");
        const options = provider.options;
        if (!options || typeof options !== "object" || !("apiKey" in options) || typeof options.apiKey !== "string") throw new Error("Missing fixture local key");
        return new Request(`http://127.0.0.1:9876/anonymous-inference/v1/${endpoint}`, {
          method: endpoint === "models" ? "GET" : "POST", headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          ...(endpoint === "models" ? {} : { body: '{ "model": "openai/gpt-5.6-luna", "messages": [] }' }),
        });
      },
    });
  } finally {
    service.stop();
    fetcher.mockRestore();
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

test("standalone server cannot enroll from env, browser headers, or a client token", async () => {
  await fixture(async ({ service, config, requests }) => {
    expect(await service.initialize(9876)).toBe(false);
    expect((await service.status(true)).state).toBe("unavailable");
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toBeUndefined();
    const response = await service.handle(new Request("http://localhost/anonymous-inference/v1/models", {
      headers: { authorization: "Bearer client-token", origin: "http://localhost", "user-agent": "OpenWork Desktop" },
    }), "models");
    expect(response.status).toBe(401);
    expect(requests).toHaveLength(0);
  }, false);
});

test("native free Luna signs session/status/models/generation and exposes only its local opaque token", async () => {
  await fixture(async ({ service, config, requests, signed, localRequest, root }) => {
    const byokFile = join(root, "opencode.json");
    const byok = '{"model":"my-provider/my-model","provider":{"my-provider":{"options":{"apiKey":"user-fixture"}}},"disabled_providers":[]}';
    await writeFile(byokFile, byok);
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: { paid: { name: "Paid Luna", options: { apiKey: "paid-fixture" } } } }));
    expect(await service.initialize(9876)).toBe(true);
    expect(requests).toHaveLength(0); // Enrollment is lazy and never needed for startup.
    expect((await service.status(true)).allowance).toEqual(ready.allowance);
    const models = await service.handle(await localRequest("models"), "models");
    expect(models.status).toBe(200);
    await models.text();
    const response = await service.handle(await localRequest(), "chat/completions");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(requests.map((request) => request.path)).toEqual([DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_CHAT_PATH]);
    const generation = signed.at(-1)!;
    expect(new TextDecoder().decode(generation.body)).toBe('{ "model": "openai/gpt-5.6-luna", "messages": [] }');
    expect(generation.authorization).toBe("Bearer remote-bearer-never-in-engine");
    expect(JSON.parse(new TextDecoder().decode(signed[0].body))).toEqual({ installationId: "798c02f8-c4f0-4c39-81b7-91e2281d122c" });
    const runtime = await readGlobalRuntimeOpencodeConfig(config);
    expect(JSON.stringify(runtime)).toContain("owf_local_");
    expect(JSON.stringify(runtime)).not.toContain("remote-bearer-never-in-engine");
    expect(runtime.provider?.paid).toEqual({ name: "Paid Luna", options: { apiKey: "paid-fixture" } });
    expect(await readFile(byokFile, "utf8")).toBe(byok);
    // Reinitialization after policy/session synchronization keeps the same free
    // provider and installation allowance, rather than switching to paid auth.
    expect(await service.initialize(9876)).toBe(false);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider).toEqual(runtime.provider);
  });
});

for (const [httpStatus, code, state] of [[426, "desktop_update_required", "update_required"], [503, "desktop_version_unavailable", "unavailable"]] as const) {
  test(`registration ${httpStatus} remains typed ${state}, not a sign-up error`, async () => {
    await fixture(async ({ service, reject, localRequest, requests }) => {
      await service.initialize(9876);
      reject(DESKTOP_FREE_SESSION_PATH, httpStatus, { error: { code, currentVersion: "0.20.0", minimumVersion: code === "desktop_update_required" ? "0.21.0" : null } });
      const status = await service.status(true);
      expect(status.state).toBe(state);
      expect(status.code).toBe(code);
      expect(status.minimumVersion).toBe(code === "desktop_update_required" ? "0.21.0" : null);
      const generation = await service.handle(await localRequest(), "chat/completions");
      expect(generation.status).toBe(httpStatus);
      expect(await generation.json()).toMatchObject({ error: { code, minimumVersion: status.minimumVersion } });
      expect(requests.every((request) => request.path === DESKTOP_FREE_SESSION_PATH)).toBe(true);
    });
  });
}

test("fresh preflight blocks a newly outdated desktop before engine or gateway generation, without gating paid/BYOK", async () => {
  await fixture(async ({ service, reject, requests, localRequest }) => {
    await service.initialize(9876);
    expect((await service.status()).state).toBe("ready");
    reject(DESKTOP_FREE_STATUS_PATH, 200, { ...ready, state: "update_required", code: "desktop_update_required", minimumVersion: "0.21.0", allowance: null });
    const prompt = (providerID: string) => new Request("http://localhost/opencode/session/test/prompt_async", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID, modelID: DESKTOP_FREE_MODEL_ID }, parts: [] }),
    });
    const before = requests.length;
    await service.assertTaskAccess(prompt("paid"), "/opencode/session/test/prompt_async");
    expect(requests).toHaveLength(before);
    await expect(service.assertTaskAccess(prompt(DESKTOP_FREE_PROVIDER_ID), "/opencode/session/test/prompt_async")).rejects.toMatchObject({ status: 426, code: "desktop_update_required", details: { minimumVersion: "0.21.0" } });
    const generation = await service.handle(await localRequest(), "chat/completions");
    expect(generation.status).toBe(426);
    expect(requests.some((request) => request.path === DESKTOP_FREE_CHAT_PATH)).toBe(false);
    // A floor change between preflight and dispatch still preserves the
    // gateway's final authoritative 426 and its machine-readable fields.
    reject(DESKTOP_FREE_STATUS_PATH, 200, ready);
    reject(DESKTOP_FREE_CHAT_PATH, 426, { error: { code: "desktop_update_required", minimumVersion: "0.22.0", currentVersion: "0.20.0" } });
    const raced = await service.handle(await localRequest(), "chat/completions");
    expect(raced.status).toBe(426);
    expect(await raced.json()).toEqual({ error: { code: "desktop_update_required", minimumVersion: "0.22.0", currentVersion: "0.20.0" } });
  });
});

test("managed policy denies initialization and dispatch without modifying policy or other providers", async () => {
  await fixture(async ({ service, config, requests, localRequest }) => {
    const paid = { name: "Paid Luna", options: { apiKey: "paid-fixture" } };
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: { paid } }));
    await writeManagedDesktopPolicy(config, { allowCustomProviders: false });
    expect(await service.initialize(9876)).toBe(false);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider).toEqual({ paid });

    await writeManagedDesktopPolicy(config, { allowCustomProviders: true });
    expect(await service.initialize(9876)).toBe(true);
    const request = await localRequest();
    await writeManagedDesktopPolicy(config, { allowCustomProviders: false });
    expect((await service.handle(request, "chat/completions")).status).toBe(503);
    expect((await service.status(true)).state).toBe("unavailable");
    expect(requests).toHaveLength(0);

    expect(await service.initialize(9876)).toBe(true);
    const runtime = await readGlobalRuntimeOpencodeConfig(config);
    expect(runtime.provider).toEqual({ paid });
    expect(runtime.managedPolicy?.allowCustomProviders).toBe(false);
  });
});

test("provider cleanup and reconfiguration preserve exact user edits", async () => {
  await fixture(async ({ service, config }) => {
    await service.initialize(9876);
    const original = (await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID];
    expect(isOwnedProvider(original)).toBe(true);
    const edited = { ...(typeof original === "object" ? original : {}), userNote: "explicit choice" };
    expect(isOwnedProvider(edited)).toBe(false);
    await writeGlobalRuntimeOpencodeConfig(config, (runtime) => ({ ...runtime, provider: { ...runtime.provider, [DESKTOP_FREE_PROVIDER_ID]: edited } }));
    expect(await service.initialize(9877)).toBe(false);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toEqual(edited);
    expect((await service.status()).state).toBe("unavailable");
    await writeGlobalRuntimeOpencodeConfig(config, (runtime) => ({ ...runtime, provider: { ...runtime.provider, [DESKTOP_FREE_PROVIDER_ID]: original }, disabled_providers: [DESKTOP_FREE_PROVIDER_ID] }));
    expect(await service.initialize(9877)).toBe(true);
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.[DESKTOP_FREE_PROVIDER_ID]).toBeUndefined();
  });
});
