import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  clearDenSession,
  denOriginComparisonKey,
  ensureDenActiveOrganization,
  initializeDenBootstrapConfig,
  readDenSettings,
  selectDenActiveOrganization,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../src/app/lib/den";
import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";
import { readRememberedDenOrganization } from "../src/app/lib/den-org-memory";
import { clearOrgSelectionPending, markOrgSelectionPending, readOrgSelectionPending } from "../src/app/lib/den-sign-in-intent";
import { signedInRoute } from "../src/react-app/shell/den-signin-routing";

const baseUrl = "https://den.example.test";
const user = { id: "user-a", email: "member@example.test", name: "Member" };
const firstOrg = { id: "org-a", name: "First workspace", slug: "first", role: "member" };
const lastOrg = { id: "org-b", name: "Last workspace", slug: "last", role: "member" };
const scope = { serverKey: denOriginComparisonKey(baseUrl), userId: user.id };

function saveSession(org = lastOrg) {
  writeDenSettings({
    baseUrl,
    apiBaseUrl: baseUrl,
    authToken: "previous-session",
    activeOrgId: org.id,
    activeOrgSlug: org.slug,
    activeOrgName: org.name,
  }, { persistBootstrap: false });
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  await initializeDenBootstrapConfig();
  await setDenBootstrapConfig({ baseUrl, apiBaseUrl: baseUrl });
});
afterEach(async () => GlobalRegistrator.unregister());

describe("verified organization memory across sessions", () => {
  test("a confirmed org survives sign-out and a fresh desktop sign-in returns straight to it", async () => {
    const requests: Array<{ path: string; token: string | null; body: string | undefined }> = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push({ path: url.pathname, token: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : undefined });
      if (url.pathname.endsWith("/v1/me/orgs")) return Response.json({ orgs: [firstOrg, lastOrg], activeOrgId: firstOrg.id });
      if (url.pathname.endsWith("/v1/auth/desktop-handoff/exchange")) return Response.json({ user, token: "new-session", organization: firstOrg });
      if (url.pathname.endsWith("/v1/me/active-organization")) return Response.json({ ok: true });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    try {
      saveSession();
      await ensureDenActiveOrganization({ forceServerSync: true, verifiedSession: { userId: user.id, token: "previous-session", baseUrl } });
      expect(readRememberedDenOrganization(scope)).toBe(lastOrg.id);
      clearDenSession();
      expect(readDenSettings().authToken).toBeNull();
      expect(readRememberedDenOrganization(scope)).toBe(lastOrg.id);

      const result = await exchangeHandoffAndSignIn("fresh-grant", { baseUrl, apiBaseUrl: baseUrl, desktopInitiated: true });
      expect(result.ok).toBe(true);
      expect(readDenSettings().authToken).toBe("new-session");
      expect(readDenSettings().activeOrgId).toBe(lastOrg.id);
      expect(readOrgSelectionPending().pending).toBe(false);
      expect(signedInRoute(readDenSettings().activeOrgId, { orgSelectionPending: readOrgSelectionPending().pending })).toBe("/session");
      const restoreSync = requests.filter((request) => request.path.endsWith("/v1/me/active-organization")).at(-1);
      expect(restoreSync?.token).toBe("Bearer new-session");
      expect(restoreSync?.body).toBe(JSON.stringify({ organizationId: lastOrg.id }));
    } finally {
      fetch.mockRestore();
    }
  });

  test("reconciliation never promotes an arbitrary first org into a remembered choice", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ orgs: [firstOrg, lastOrg] }));
    try {
      saveSession();
      writeDenSettings({ ...readDenSettings(), activeOrgId: null, activeOrgSlug: null, activeOrgName: null });
      // Include the subsequent reconciliation that a settings change would
      // trigger: an automatic fallback must not become an apparent user choice.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await ensureDenActiveOrganization({ verifiedSession: { userId: user.id, token: "previous-session", baseUrl } })).toBeNull();
        expect(readDenSettings().activeOrgId).toBeNull();
        expect(readRememberedDenOrganization(scope)).toBeNull();
      }
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("acknowledged organization choices", () => {
  test("success records the choice before any background refresh or sign-out", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/v1/me")) return Response.json({ user });
      if (String(input).endsWith("/v1/me/active-organization")) return Response.json({ ok: true });
      throw new Error(`No background directory refresh should be needed: ${String(input)}`);
    });
    try {
      saveSession(firstOrg);
      await selectDenActiveOrganization(lastOrg, readDenSettings());
      expect(readDenSettings().activeOrgId).toBe(lastOrg.id);
      clearDenSession();
      expect(readRememberedDenOrganization(scope)).toBe(lastOrg.id);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });

  test("a refused choice leaves the active org and preference untouched", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/v1/me")) return Response.json({ user });
      return Response.json({ error: "forbidden", message: "No longer a member." }, { status: 403 });
    });
    try {
      saveSession(firstOrg);
      await expect(selectDenActiveOrganization(lastOrg, readDenSettings())).rejects.toThrow("No longer a member.");
      expect(readDenSettings().activeOrgId).toBe(firstOrg.id);
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("canceling a switch stops a pending choice before it changes the server", async () => {
    const response = deferred<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(() => response.promise);
    try {
      saveSession(firstOrg);
      markOrgSelectionPending(firstOrg);
      const pending = selectDenActiveOrganization(lastOrg, readDenSettings());
      clearOrgSelectionPending();
      response.resolve(Response.json({ user }));
      await expect(pending).rejects.toThrow("Your sign-in or organization changed");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(readDenSettings().activeOrgId).toBe(firstOrg.id);
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("a choice resolving after sign-out cannot restore the session or update memory", async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/v1/me")) return Response.json({ user });
      started.resolve();
      return response.promise;
    });
    try {
      saveSession(firstOrg);
      const pending = selectDenActiveOrganization(lastOrg, readDenSettings());
      await started.promise;
      clearDenSession();
      response.resolve(Response.json({ ok: true }));
      await expect(pending).rejects.toThrow("Your sign-in or organization changed");
      expect(readDenSettings().authToken).toBeNull();
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("organization refresh continuity", () => {
  test("a retry cannot apply a verified identity to a different session", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("A stale verified session must not fetch an organization directory");
    });
    try {
      saveSession();
      writeDenSettings({ ...readDenSettings(), authToken: "different-account-session" });
      expect(await ensureDenActiveOrganization({
        verifiedSession: { userId: user.id, token: "previous-session", baseUrl },
      })).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("a verified identity from another control plane cannot seed a preference", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("A different origin's identity must not fetch an organization directory");
    });
    try {
      saveSession();
      expect(await ensureDenActiveOrganization({
        verifiedSession: { userId: user.id, token: "previous-session", baseUrl: "https://other.example.test" },
      })).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("a slow refresh cannot overwrite a newer organization choice", async () => {
    const response = deferred<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(() => response.promise);
    try {
      saveSession(firstOrg);
      const pending = ensureDenActiveOrganization({ verifiedSession: { userId: user.id, token: "previous-session", baseUrl } });
      saveSession(lastOrg);
      response.resolve(Response.json({ orgs: [firstOrg, lastOrg], activeOrgId: firstOrg.id }));
      expect(await pending).toBeNull();
      expect(readDenSettings().activeOrgId).toBe(lastOrg.id);
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("a slow refresh cannot resurrect credentials after sign-out", async () => {
    const response = deferred<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(() => response.promise);
    try {
      saveSession();
      const pending = ensureDenActiveOrganization({ verifiedSession: { userId: user.id, token: "previous-session", baseUrl } });
      clearDenSession();
      response.resolve(Response.json({ orgs: [firstOrg, lastOrg] }));
      expect(await pending).toBeNull();
      expect(readDenSettings().authToken).toBeNull();
      expect(readDenSettings().activeOrgId).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("an org switch during server synchronization is not overwritten", async () => {
    const sync = deferred<Response>();
    const started = deferred<void>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/me/orgs")) return Response.json({ orgs: [firstOrg, lastOrg], activeOrgId: lastOrg.id });
      started.resolve();
      return sync.promise;
    });
    try {
      saveSession(firstOrg);
      const pending = ensureDenActiveOrganization({ forceServerSync: true, verifiedSession: { userId: user.id, token: "previous-session", baseUrl } });
      await started.promise;
      saveSession(lastOrg);
      sync.resolve(Response.json({ ok: true }));
      expect(await pending).toBeNull();
      expect(readDenSettings().activeOrgId).toBe(lastOrg.id);
      expect(readRememberedDenOrganization(scope)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });
});
