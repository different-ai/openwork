import { createServer, type ServerResponse } from "node:http";
import { addInitScript, browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

/** Real app renderer/server; a test-owned Den HTTP boundary holds identity and
 * directory responses independently. No provider or customer service is used. */
export async function denSignInOrganizationDelay(seed: Seed) {
  const resources = new AsyncDisposableStack();
  let holdSession = true;
  let holdOrganizations = true;
  let revoked = false;
  let sessionRequests = 0;
  let organizationRequests = 0;
  let appOrigin: string | undefined;
  const pendingSessions = new Set<ServerResponse>();
  const pendingOrganizations = new Set<ServerResponse>();
  const organization = { id: "org_startup", slug: "startup", name: "Recovered workspace", role: "member" };
  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const session = (response: ServerResponse) => revoked
    ? json(response, { error: "unauthorized", message: "Session revoked" }, 401)
    : json(response, { user: { id: "user_startup", email: "member@example.test", name: "Returning Member" } });
  const directory = (response: ServerResponse) => json(response, {
    orgs: [organization], activeOrgId: organization.id, activeOrgSlug: organization.slug,
  });
  const server = createServer((request, response) => {
    if (appOrigin && request.headers.origin === appOrigin) {
      response.setHeader("access-control-allow-origin", appOrigin);
      response.setHeader("access-control-allow-credentials", "true");
    }
    response.setHeader("access-control-allow-headers", "authorization, content-type, x-openwork-org-id, x-openwork-legacy-org-id");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (path === "/api/runtime-config") return json(response, {});
    if (path === "/v1/me") {
      sessionRequests++;
      if (!holdSession) return session(response);
      pendingSessions.add(response);
      response.once("close", () => pendingSessions.delete(response));
      return;
    }
    if (path === "/v1/me/orgs") {
      organizationRequests++;
      if (!holdOrganizations) return directory(response);
      pendingOrganizations.add(response);
      response.once("close", () => pendingOrganizations.delete(response));
      return;
    }
    if (path === "/v1/me/desktop-config") return json(response, {});
    if (path === "/v1/me/active-organization") return json(response, { organization });
    return json(response, { error: "not_found" }, 404);
  });
  resources.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Den startup fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const app = await seed.appWeb({
      name: "den-sign-in-organization-delay", workspacePath: seed.tmpPath("startup-workspace"),
      headless: true, env: {
        VITE_DEN_REQUIRE_SIGNIN: "1",
        ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
      },
      den: { apiUrl: origin, webUrl: origin },
    });
    appOrigin = new URL(app.webUrl).origin;
    let registration: Awaited<ReturnType<typeof addInitScript>> | undefined;
    resources.defer(async () => { await registration?.[Symbol.asyncDispose](); });
    return {
      app,
      async restore(cachedOrganization = true) {
        await registration?.[Symbol.asyncDispose]();
        registration = await addInitScript(app.client, browserScript((denOrigin, hasOrganization) => {
          localStorage.setItem("openwork.den.baseUrl", denOrigin);
          localStorage.setItem("openwork.den.sessionOrigin", denOrigin);
          localStorage.setItem("openwork.den.authToken", "fixture-startup-session");
          for (const [key, value] of [
            ["activeOrgId", "org_startup"], ["activeOrgSlug", "startup"], ["activeOrgName", "Saved workspace"],
          ]) {
            if (hasOrganization) localStorage.setItem(`openwork.den.${key}`, value);
            else localStorage.removeItem(`openwork.den.${key}`);
          }
        }, [origin, cachedOrganization]));
        await reload(app);
      },
      releaseSession() {
        holdSession = false;
        for (const response of pendingSessions) session(response);
        pendingSessions.clear();
      },
      releaseOrganizations() {
        holdOrganizations = false;
        for (const response of pendingOrganizations) directory(response);
        pendingOrganizations.clear();
      },
      revokeSession() { revoked = true; },
      traffic: () => ({ sessionRequests, organizationRequests, heldSessions: pendingSessions.size, heldOrganizations: pendingOrganizations.size }),
      snapshot: () => seed.evalIn(app, async () => ({
        auth: await window.__openworkControl.execute("auth.status", {}),
        tokenPresent: Boolean(localStorage.getItem("openwork.den.authToken")),
        organizationId: localStorage.getItem("openwork.den.activeOrgId"),
        organizationName: localStorage.getItem("openwork.den.activeOrgName"),
      }), { awaitPromise: true }),
      [Symbol.asyncDispose]: () => resources.disposeAsync(),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
