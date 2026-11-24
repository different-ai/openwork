import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { initializeDenBootstrapConfig, readDenBootstrapConfig, readDenSettings, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import * as den from "../src/app/lib/den";
import { denDeviceLogin, isConfiguredDenDeviceDestination, readDeviceLoginDeployment } from "../src/app/lib/den-device-login";
import { beginDenEnrollment, commitDenEnrollment, exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { readOrgSelectionPending } from "../src/app/lib/den-sign-in-intent";

const baseUrl = "https://den.example.test";
const user = { id: "user-a", email: "member@example.test", name: "Member" };
const orgA = { id: "org-a", name: "First workspace", slug: "first", role: "member" };
const orgB = { id: "org-b", name: "Second workspace", slug: "second", role: "member" };
const options = { baseUrl, apiBaseUrl: baseUrl, force: true };

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  await initializeDenBootstrapConfig();
  await setDenBootstrapConfig({ baseUrl, apiBaseUrl: baseUrl });
  writeDenSettings({ ...options, authToken: "previous-session", activeOrgId: orgA.id, activeOrgName: orgA.name, activeOrgSlug: orgA.slug }, { persistBootstrap: false });
});
afterEach(async () => {
  denDeviceLogin.cancel();
  await GlobalRegistrator.unregister();
});

function server(input: { sessionOrg?: string | null; activeOrg?: string; orgs?: typeof orgA[]; enabled?: boolean; tokenResponse?: Promise<Response> } = {}) {
  const requests: string[] = [];
  const tokenRequested = deferred<void>();
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === "/v1/features") return Response.json({ features: { remoteDesktopDeviceLogin: input.enabled !== false } });
    if (path === "/api/auth/device/code") return Response.json({ device_code: "private-code", user_code: "ABCD-EFGH", expires_in: 900, interval: 1 });
    if (path === "/api/auth/device/token") {
      tokenRequested.resolve();
      return input.tokenResponse ?? Response.json({ access_token: "new-device-session" });
    }
    if (path === "/v1/me") return Response.json({ user, session: { activeOrganizationId: input.sessionOrg === undefined ? orgB.id : input.sessionOrg } });
    if (path === "/v1/me/orgs") return Response.json({ orgs: input.orgs ?? [orgA, orgB], activeOrgId: input.activeOrg ?? orgB.id });
    if (path === "/v1/auth/desktop-handoff/exchange") return Response.json({ user, token: "new-handoff-session", organization: orgA });
    throw new Error("Unexpected test request.");
  });
  return { fetch, requests, tokenRequested: tokenRequested.promise };
}

async function terminal() {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const state = denDeviceLogin.status().state;
    if (state !== "pending" && state !== "approved") return denDeviceLogin.status();
    await Bun.sleep(10);
  }
  throw new Error("Device test did not settle.");
}

describe("anonymous device deployment discovery", () => {
  test.each([401, 403, 404, 422])("signed-out discovery HTTP %i reports refusal without a force conflict or response body", async (httpStatus) => {
    writeDenSettings({ authToken: null }, { persistBootstrap: false });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ message: "https://secret.invalid/private?token=private-bearer" }, { status: httpStatus });
    });
    try {
      const started = await denDeviceLogin.start({ baseUrl, apiBaseUrl: baseUrl, requestId: "refused-owner" });
      expect(started).toEqual({ state: "failed", reason: "den_refused", host: "den.example.test", httpStatus });
      expect(denDeviceLogin.status("refused-owner")).toEqual(started);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(readDenSettings().authToken).toBeNull();
      expect(JSON.stringify(started)).not.toMatch(/https?:|private|bearer|secret|force|already_signed_in/);
    } finally { fetch.mockRestore(); }
  });

  test.each(["network", "503"])("bounded %s exhaustion exposes only the safe destination host", async (failure) => {
    const paths: string[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (failure === "network") throw new TypeError("https://secret.invalid/private?token=private-bearer");
      return Response.json({ message: "https://secret.invalid/private?token=private-bearer" }, { status: 503 });
    });
    const began = performance.now();
    try {
      const started = await denDeviceLogin.start({ baseUrl, apiBaseUrl: "http://127.0.0.1:8788/api/den", force: true, requestId: "network-owner" });
      expect(started).toEqual({ state: "failed", reason: "den_unreachable", host: "127.0.0.1:8788" });
      expect(denDeviceLogin.status("network-owner")).toEqual(started);
      expect(JSON.stringify([started, denDeviceLogin.status()])).not.toMatch(/https?:|private|bearer|secret/);
      expect(paths).toEqual(Array(3).fill("/api/den/v1/features"));
      expect(performance.now() - began).toBeLessThan(2500);
      expect(readDenSettings().authToken).toBe("previous-session");
    } finally { fetch.mockRestore(); }
  });

  test.each(["network", "503"])("one transient %s retries the anonymous read but not code writes", async (failure) => {
    const s = server();
    const normal = s.fetch.getMockImplementation();
    let discoveryCalls = 0;
    s.fetch.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/v1/features" && ++discoveryCalls === 1) {
        if (failure === "network") throw new TypeError("Synthetic network failure");
        return Response.json({}, { status: 503 });
      }
      if (!normal) throw new Error("Missing test server implementation");
      return normal(url, init);
    });
    try {
      expect(await denDeviceLogin.start(options)).toHaveProperty("userCode");
      expect(discoveryCalls).toBe(2);
      expect(s.requests.filter((path) => path === "/api/auth/device/code")).toHaveLength(1);
      denDeviceLogin.cancel();
    } finally { s.fetch.mockRestore(); }
  });

  test("abort during retry sleep stops immediately without a second read or device code", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}, { status: 503 }));
    try {
      const started = denDeviceLogin.start(options);
      while (fetch.mock.calls.length === 0) await Bun.sleep(1);
      await Bun.sleep(20);
      denDeviceLogin.cancel();
      expect(await started).toHaveProperty("ok", false);
      await Bun.sleep(180);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(denDeviceLogin.status()).not.toHaveProperty("reason");
      expect(readDenSettings().authToken).toBe("previous-session");
    } finally { fetch.mockRestore(); }
  });

  test("each stalled anonymous read has a finite deadline inside the prepare budget", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Discovery must carry an abort signal");
      signal.addEventListener("abort", () => reject(new Error("private timeout details")), { once: true });
    }));
    const began = performance.now();
    try {
      expect(await denDeviceLogin.start(options)).toEqual({ state: "failed", reason: "den_unreachable", host: "den.example.test" });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(performance.now() - began).toBeLessThan(6500);
    } finally { fetch.mockRestore(); }
  }, 8000);

  test.each([{}, { features: {} }, { features: { remoteDesktopDeviceLogin: "false" } }])("missing or malformed flags fail closed, not unsupported or unreachable (%j)", async (payload) => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload));
    try {
      expect(await denDeviceLogin.start(options)).toHaveProperty("ok", false);
      expect(denDeviceLogin.status().state).toBe("failed");
      expect(denDeviceLogin.status()).not.toHaveProperty("reason");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  test("interrupted discovery bodies retry, but malformed JSON does not", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("private connection details")); },
    }))).mockImplementation(async () => Response.json({ features: { remoteDesktopDeviceLogin: true } }));
    try {
      expect(await readDeviceLoginDeployment(baseUrl, new AbortController().signal)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      fetch.mockClear();
      fetch.mockImplementation(async () => new Response("malformed private response", { status: 200 }));
      expect(await denDeviceLogin.start(options)).toHaveProperty("ok", false);
      expect(denDeviceLogin.status()).not.toHaveProperty("reason");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  test("a newer start aborts the previous retry pause and owns the terminal result", async () => {
    let calls = 0;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return calls === 1 ? Response.json({}, { status: 503 }) : Response.json({ features: { remoteDesktopDeviceLogin: false } });
    });
    try {
      const old = denDeviceLogin.start({ ...options, requestId: "old" });
      while (calls === 0) await Bun.sleep(1);
      await Bun.sleep(20);
      expect(await denDeviceLogin.start({ ...options, requestId: "new" })).toHaveProperty("state", "unsupported");
      expect(await old).toHaveProperty("ok", false);
      await Bun.sleep(180);
      expect(calls).toBe(2);
      expect(denDeviceLogin.status("new").state).toBe("unsupported");
      expect(denDeviceLogin.status("old").state).toBe("failed");
    } finally { fetch.mockRestore(); }
  });

  test("a pre-aborted read makes no request", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(readDeviceLoginDeployment(baseUrl, controller.signal)).rejects.toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});

describe("device enrollment uses the handoff transaction", () => {
  test("the local deployment gate matches explicit same-server URLs but not an alternate API", () => {
    expect(isConfiguredDenDeviceDestination({})).toBe(true);
    expect(isConfiguredDenDeviceDestination({ baseUrl: `${baseUrl}/`, apiBaseUrl: readDenSettings().apiBaseUrl ?? undefined })).toBe(true);
    expect(isConfiguredDenDeviceDestination({ baseUrl: "https://other.example.test" })).toBe(false);
    expect(isConfiguredDenDeviceDestination({ apiBaseUrl: "https://other.example.test" })).toBe(false);
  });
  test("anonymous deployment gate rejects even an authenticated forced replacement", async () => {
    const handoff = beginDenEnrollment();
    const s = server({ enabled: false });
    try {
      expect(await denDeviceLogin.start(options)).toHaveProperty("state", "unsupported");
      expect(handoff.isCurrent()).toBe(true);
      expect(s.requests).toEqual(["/v1/features"]);
      const init = s.fetch.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(readDenSettings().authToken).toBe("previous-session");
    } finally { s.fetch.mockRestore(); }
  });

  test("adopts org B without a chooser even when best-effort feature usage reporting fails", async () => {
    const usage = spyOn(den, "markFeatureUsed").mockImplementation(() => { throw new Error("Reporting unavailable."); });
    const s = server();
    try {
      const started = await denDeviceLogin.start(options);
      expect(started).toHaveProperty("expiresAt");
      const status = await terminal();
      expect(status).toEqual({ state: "signed_in", email: user.email, org: { id: orgB.id, name: orgB.name } });
      expect(readDenSettings().authToken).toBe("new-device-session");
      expect(readDenSettings().activeOrgId).toBe(orgB.id);
      expect(readOrgSelectionPending().pending).toBe(false);
      expect(s.requests).toEqual(["/v1/features", "/api/auth/device/code", "/api/auth/device/token", "/v1/me", "/v1/me/orgs"]);
      expect(JSON.stringify([started, status])).not.toMatch(/private-code|new-device-session/);
      expect(usage).toHaveBeenCalledWith("remoteDesktopDeviceLogin");
    } finally { s.fetch.mockRestore(); usage.mockRestore(); }
  });

  test.each([
    { sessionOrg: null },
    { activeOrg: orgA.id },
    { orgs: [orgA] },
  ])("refuses missing, changed or removed approved org (%j), retaining enrollment", async (input) => {
    const s = server(input);
    try {
      await denDeviceLogin.start(options);
      expect((await terminal()).state).toBe("failed");
      expect(readDenSettings().authToken).toBe("previous-session");
      expect(readDenSettings().activeOrgId).toBe(orgA.id);
      expect(s.requests).not.toContain("/v1/me/active-organization");
    } finally { s.fetch.mockRestore(); }
  });

  test("a newer handoff wins over an in-flight token response", async () => {
    const response = deferred<Response>();
    const s = server({ tokenResponse: response.promise });
    try {
      await denDeviceLogin.start(options);
      await s.tokenRequested;
      expect((await exchangeHandoffAndSignIn("one-time-grant", { ...options, desktopInitiated: false })).ok).toBe(true);
      response.resolve(Response.json({ access_token: "late-device-session" }));
      await Bun.sleep(20);
      expect(denDeviceLogin.status().state).toBe("failed");
      expect(readDenSettings().authToken).toBe("new-handoff-session");
      expect(s.requests).not.toContain("/v1/me");
    } finally { response.resolve(Response.json({ error: "expired_token" }, { status: 400 })); s.fetch.mockRestore(); }
  });

  test("cancel during durable bootstrap persistence rolls back before activation", async () => {
    const destination = { baseUrl: "https://other.example.test", apiBaseUrl: "https://other.example.test" };
    const attempt = beginDenEnrollment();
    const cancelOnCommit = () => {
      if (readDenBootstrapConfig().baseUrl === destination.baseUrl) attempt.cancel();
    };
    window.addEventListener(denSettingsChangedEvent, cancelOnCommit);
    try {
      const result = await commitDenEnrollment({
        attempt, destination, storedSettings: readDenSettings(),
        exchange: { token: "new-device-session", user, organization: orgB, connectEnabled: null },
        options: { ...destination, activeOrg: orgB, desktopInitiated: false },
        safeErrors: true,
      });
      expect(result).toMatchObject({ ok: false, stale: true });
      expect(readDenBootstrapConfig().baseUrl).toBe(baseUrl);
      expect(readDenSettings().authToken).toBe("previous-session");
      expect(readDenSettings().activeOrgId).toBe(orgA.id);
    } finally { window.removeEventListener(denSettingsChangedEvent, cancelOnCommit); }
  });

  test("cancelling an old device attempt cannot supersede a newer handoff attempt", () => {
    const old = beginDenEnrollment();
    const newer = beginDenEnrollment();
    old.cancel();
    expect(old.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);
    newer.cancel();
  });
});
