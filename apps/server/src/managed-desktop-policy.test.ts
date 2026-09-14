import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { ServerConfig } from "./types.js";

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
  const parse = mock((_value: unknown) => policy);
  const read = mock(async (): Promise<{ managedPolicy?: typeof policy }> => ({}));
  const write = mock(async (_config: ServerConfig, _policy: unknown) => ({ changed: false }));
  mock.module("node:timers/promises", () => ({ setTimeout: delay }));
  mock.module("./server-fetch.js", () => ({ externalFetch }));
  mock.module("@openwork/types/den/desktop-policies-runtime", () => ({ desktopConfigSchema: { parse } }));
  mock.module("./runtime-opencode-config-store.js", () => ({
    readGlobalRuntimeOpencodeConfig: read, writeManagedDesktopPolicy: write,
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
    read.mockReset().mockImplementation(async () => ({}));
    write.mockClear();
    service = managedDesktopPolicy({ ...config });
  });
  afterEach(() => { release.resolve(); });

  test.each([false, true])("no-session browser evaluation fences identity installation during its persisted read (install=%s)", async (install) => {
    const reading = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<Awaited<ReturnType<typeof read>>>();
    read.mockImplementationOnce(() => { reading.resolve(); return persisted.promise; });
    const result = service.assert("browser", { url: "https://unapproved.example" }).catch((error: unknown) => error);
    await reading.promise;
    if (install) await service.setSession(session);
    persisted.resolve({});
    if (install) expect(await result).toMatchObject({ code: "policy_identity_changed", status: 409 });
    else expect(await result).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(externalFetch).toHaveBeenCalledTimes(install ? 1 : 0);
    expect(write).toHaveBeenCalledTimes(install ? 1 : 0);
  });

  test("no-session browser evaluation keeps retained managed policy fail closed", async () => {
    read.mockResolvedValue({ managedPolicy: policy });
    await expect(service.assert("browser", { url: "https://unapproved.example" })).rejects.toMatchObject({ code: "policy_unavailable", status: 403 });
    expect(externalFetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

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
