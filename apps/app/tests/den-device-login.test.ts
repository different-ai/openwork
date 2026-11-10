import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { initializeDenBootstrapConfig, readDenBootstrapConfig, readDenSettings, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import * as den from "../src/app/lib/den";
import { denDeviceLogin, isConfiguredDenDeviceDestination } from "../src/app/lib/den-device-login";
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
      expect(status).toEqual({ state: "signed_in", email: user.email, org: { id: orgB.id, name: orgB.name }, runner: "unknown" });
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
