import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { ServerConfig } from "./types.js";
import type { DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";

// Bun 1.3.4 cannot isolate files; mock.restore() does not undo mock.module().
// Run these replacements in a child so they cannot contaminate other files.
if (process.env.OPENWORK_MANAGED_POLICY_TEST_CHILD !== "1") {
  test("ManagedDesktopPolicy orchestration (isolated module mocks)", () => {
    const result = spawnSync(process.execPath, ["--conditions=development", "test", import.meta.path, "--timeout=1000"], {
      env: { ...process.env, OPENWORK_MANAGED_POLICY_TEST_CHILD: "1" },
      encoding: "utf8", timeout: 8000,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }, 10000);
} else {
  const policy = { allowCustomProviders: false };
  const session = { baseUrl: "https://den.invalid", token: "old-token", orgId: "old-org" };
  let waiting = Promise.withResolvers<number>();
  let release = Promise.withResolvers<void>();
  const delay = mock((ms: number) => { waiting.resolve(ms); return release.promise; });
  const externalFetch = mock(async (_url: string, _init?: RequestInit) => Response.json(policy));
  const parse = mock((_value: unknown): DesktopConfig => policy);
  let persistedPolicy: unknown;
  const persist = async (_config: ServerConfig, nextPolicy: unknown) => { persistedPolicy = nextPolicy; return { changed: false }; };
  const write = mock(persist);
  mock.module("node:timers/promises", () => ({ setTimeout: delay }));
  mock.module("./server-fetch.js", () => ({ externalFetch }));
  mock.module("@openwork/types/den/desktop-policies-runtime", () => ({ desktopConfigSchema: { parse } }));
  mock.module("./runtime-opencode-config-store.js", () => ({
    readGlobalRuntimeOpencodeConfig: async () => ({ managedPolicy: persistedPolicy }), writeManagedDesktopPolicy: write,
    runtimeProviderMap: () => ({}),
  }));
  mock.module("./workspace-kv-store.js", () => ({
    isRecord: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
  }));
  mock.module("./managed-policy-rules.js", () => ({ policyDenial: () => null, policyRequestActions: () => [] }));
  const { managedDesktopPolicy } = await import("./managed-desktop-policy.js");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test",
    approval: { mode: "auto", timeoutMs: 30000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated",
    logFormat: "pretty", logRequests: false,
  };
  let service = managedDesktopPolicy({ ...config });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  beforeEach(() => {
    waiting = Promise.withResolvers<number>();
    release = Promise.withResolvers<void>();
    delay.mockClear();
    externalFetch.mockReset().mockImplementation(async () => Response.json(policy));
    parse.mockReset().mockImplementation(() => policy);
    persistedPolicy = undefined;
    write.mockReset().mockImplementation(persist);
    service = managedDesktopPolicy({ ...config });
  });
  afterEach(() => { release.resolve(); });

  test("503 waits for the explicit 200ms release before the second read succeeds", async () => {
    externalFetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const installing = service.setSession(session);
    const current = service.current();
    expect(service.current()).toBe(current);
    expect(await waiting.promise).toBe(200);
    await turn();
    expect(delay).toHaveBeenCalledTimes(1);
    expect(externalFetch).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    release.resolve();
    expect(await current).toEqual(policy);
    await installing;
    await turn();
    expect(externalFetch).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledWith(policy);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[1]).toEqual(policy);
  });

  test("a second 503 fails closed without a third attempt or delay", async () => {
    externalFetch.mockImplementation(async () => new Response(null, { status: 503 }));
    const result = service.setSession(session).catch((error: unknown) => error);
    expect(await waiting.promise).toBe(200);
    release.resolve();
    expect(await result).toMatchObject({ code: "policy_unavailable", status: 403 });
    await turn();
    expect(externalFetch).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([401, 403, 429])("HTTP %i is not retried", async (status) => {
    externalFetch.mockImplementation(async () => new Response(null, { status }));
    await expect(service.setSession(session)).rejects.toMatchObject({ code: "policy_unavailable", status: 403 });
    expect(externalFetch).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("schema rejection is not retried", async () => {
    externalFetch.mockImplementation(async () => Response.json(null));
    parse.mockImplementationOnce(() => { throw new Error("Invalid desktop config"); });
    await expect(service.setSession(session)).rejects.toMatchObject({ code: "policy_unavailable", status: 403 });
    expect(parse).toHaveBeenCalledWith(null);
    expect(externalFetch).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("identity change during backoff prevents another old-identity fetch or write", async () => {
    externalFetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const result = service.setSession(session).catch((error: unknown) => error);
    expect(await waiting.promise).toBe(200);
    const next = { ...session, token: "new-token", orgId: "new-org" };
    const installing = service.setSession(next);
    expect(await service.current()).toEqual(policy);
    await installing;
    release.resolve();
    expect(await result).toMatchObject({ code: "policy_identity_changed", status: 409 });
    await turn();
    expect(externalFetch.mock.calls.map(([url, init]) => [url, init?.headers])).toEqual([
      [`${session.baseUrl}/v1/me/desktop-config`, { Accept: "application/json", Authorization: "Bearer old-token", "x-openwork-org-id": "old-org", "x-openwork-legacy-org-id": "old-org" }],
      [`${next.baseUrl}/v1/me/desktop-config`, { Accept: "application/json", Authorization: "Bearer new-token", "x-openwork-org-id": "new-org", "x-openwork-legacy-org-id": "new-org" }],
    ]);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  const offline = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } }); };
  const verified = async () => {
    await service.setSession(session);
    await turn();
    const snapshot = await service.forUpdater();
    await turn();
    expect(snapshot.verification).toBe("fresh");
    if (snapshot.verification !== "fresh") throw new Error("Expected a freshly verified updater identity");
    return snapshot;
  };

  test("an unmanaged updater authority needs neither Den nor sign-in", async () => {
    expect(await service.forUpdater()).toEqual({ verification: "unmanaged", identity: null, policy: null });
    expect(externalFetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("updater cache is identity-bound and the ordinary policy read still fails closed offline", async () => {
    const first = await verified();
    await service.setSession({ ...session });
    await turn();
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.current()).rejects.toMatchObject({ code: "policy_unavailable", status: 403 });
    await turn();
    const cached = await service.forUpdater();
    expect(cached).toEqual({ verification: "cached-offline", identity: first.identity, policy });
    expect(typeof cached.identity).toBe("string");
    expect(JSON.stringify(cached)).not.toContain(session.token);
    expect(JSON.stringify(cached)).not.toContain(session.orgId);
  });

  test("an offline first read cannot manufacture an approved updater cache", async () => {
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.setSession(session)).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test.each([
    Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    new Error("net::ERR_INTERNET_DISCONNECTED"),
    new Error("net::ERR_CONNECTION_REFUSED"),
  ])("known Bun, Node and Electron network failures retain only attested offline permission %#", async (error) => {
    const first = await verified();
    externalFetch.mockImplementation(async () => { throw error; });
    release.resolve();
    expect(await service.forUpdater()).toEqual({ verification: "cached-offline", identity: first.identity, policy });
  });

  test.each(["net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_INVALID_AUTH_CREDENTIALS", "upstream said net::ERR_INTERNET_DISCONNECTED"])(
    "%s is not accepted as a Chromium offline grant", async (message) => {
      await verified();
      externalFetch.mockImplementation(async () => { throw new Error(message); });
      await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    },
  );

  test("sign-out removes cached updater permission and same-token re-entry gets a new identity", async () => {
    const first = await verified();
    await service.clearSession();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    const next = await verified();
    expect(next.identity).not.toBe(first.identity);
  });

  test.each([
    { ...session, token: "different-token" },
    { ...session, orgId: "different-org" },
    { ...session, baseUrl: "https://other-den.invalid" },
  ])("credential, organization, and origin changes cannot reuse offline updater permission %#", async (next) => {
    const first = await verified();
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.setSession(next)).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(async () => Response.json(policy));
    expect((await service.forUpdater()).identity).not.toBe(first.identity);
  });

  test.each([401, 403, 404, 429])("HTTP %i invalidates updater cache; a later outage cannot revive access", async (status) => {
    await verified();
    externalFetch.mockImplementation(async () => new Response(null, { status }));
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test.each([401, 403])("auth loss HTTP %i on another authority read also removes offline updater permission", async (status) => {
    await verified();
    externalFetch.mockImplementation(async (url) => url.endsWith("/v1/me/desktop-config")
      ? Response.json(policy)
      : new Response(null, { status }));
    await expect(service.assert("model", { providerID: "lpr_fixture", modelID: "fixture-model" })).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test("a late policy success cannot overwrite auth loss observed by another in-flight authority read", async () => {
    await verified();
    const catalogRequested = Promise.withResolvers<void>();
    const catalogReply = Promise.withResolvers<Response>();
    externalFetch.mockImplementation(async (url) => {
      if (url.endsWith("/v1/me/desktop-config")) return Response.json(policy);
      catalogRequested.resolve();
      return catalogReply.promise;
    });
    const modelRead = service.assert("model", { providerID: "lpr_fixture", modelID: "fixture-model" }).catch((error: unknown) => error);
    await catalogRequested.promise;
    await turn();
    const policyRequested = Promise.withResolvers<void>();
    const policyReply = Promise.withResolvers<Response>();
    externalFetch.mockImplementation(async () => { policyRequested.resolve(); return policyReply.promise; });
    const latePolicy = service.forUpdater().catch((error: unknown) => error);
    await policyRequested.promise;
    catalogReply.resolve(new Response(null, { status: 401 }));
    expect(await modelRead).toMatchObject({ code: "policy_unavailable" });
    policyReply.resolve(Response.json(policy));
    expect(await latePolicy).toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test("a temporary 503 may return an existing verified cache but never a fresh receipt", async () => {
    const first = await verified();
    externalFetch.mockImplementation(async () => new Response(null, { status: 503 }));
    release.resolve();
    expect(await service.forUpdater()).toEqual({ verification: "cached-offline", identity: first.identity, policy });
  });

  test("invalid policy and unknown TLS failures are not offline authorization", async () => {
    await verified();
    parse.mockImplementationOnce(() => { throw new Error("invalid policy"); });
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(offline);
    release.resolve();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(async () => Response.json(policy));
    await verified();
    externalFetch.mockImplementation(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }); });
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    await turn();
    externalFetch.mockImplementation(offline);
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test.each([{ error: "not authorized" }, { policy: { allowedDesktopVersions: [] } }])(
    "a 200 error/envelope cannot be stripped into an unrestricted updater grant %#", async (payload) => {
      await verified();
      externalFetch.mockImplementation(async () => Response.json(payload));
      parse.mockImplementationOnce(() => ({}));
      await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
      await turn();
      externalFetch.mockImplementation(offline);
      release.resolve();
      await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
    },
  );

  test("an observed version revocation replaces the updater cache even if persistence fails", async () => {
    parse.mockImplementation(() => ({ ...policy, allowedDesktopVersions: ["0.17.23"] }));
    const first = await verified();
    const revoked = { ...policy, allowedDesktopVersions: ["0.17.0"] };
    parse.mockImplementationOnce(() => revoked);
    write.mockImplementationOnce(async () => { throw new Error("storage unavailable"); });
    await expect(service.forUpdater()).rejects.toThrow("storage unavailable");
    await turn();
    externalFetch.mockImplementation(offline);
    release.resolve();
    expect(await service.forUpdater()).toEqual({ verification: "cached-offline", identity: first.identity, policy: revoked });
  });

  test("sign-out during a retry cannot complete an offline authorization for the old identity", async () => {
    await verified();
    externalFetch.mockImplementation(async () => new Response(null, { status: 503 }));
    const pending = service.forUpdater().catch((error: unknown) => error);
    expect(await waiting.promise).toBe(200);
    await service.clearSession();
    release.resolve();
    expect(await pending).toMatchObject({ code: "policy_identity_changed", status: 409 });
    await turn();
    await expect(service.forUpdater()).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test("re-delivering the same identity during backoff keeps the in-flight verification", async () => {
    externalFetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const result = service.setSession(session);
    expect(await waiting.promise).toBe(200);
    const redelivered = service.setSession({ ...session });
    release.resolve();
    await expect(result).resolves.toBeUndefined();
    await expect(redelivered).resolves.toBeUndefined();
    await turn();
    expect(externalFetch).toHaveBeenCalledTimes(2);
    expect(externalFetch.mock.calls.every(([, init]) => init?.headers && "Authorization" in init.headers && init.headers.Authorization === "Bearer old-token")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
}
