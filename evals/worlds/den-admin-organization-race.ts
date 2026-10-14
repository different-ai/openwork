import type { Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

type OrganizationFault = "connection-reset" | "abort";
type AdminRead = {
  kind: string; status: number | null; rows: number; total: number | null;
  held: boolean; completed: boolean; fault?: OrganizationFault;
  networkError?: string; canceled?: boolean;
};

/** Delay genuine responses or interrupt organization transport; never invent an auth response. */
async function overviewTransport(web: Surface, origin: string) {
  if (!web.client.webSocketDebuggerUrl) throw new Error("Overview timing requires browser CDP.");
  const socket = new WebSocket(web.client.webSocketDebuggerUrl);
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const active = new Set<Promise<void>>();
  const held = new Map<string, () => void>();
  const errors: Error[] = [];
  const requests: AdminRead[] = [];
  const faultedRequests = new Map<string, AdminRead>();
  let organizationFault: OrganizationFault | null = null;
  let holding = false;
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Overview transport timeout: ${method}`)); }, 10_000);
    calls.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  async function intercept(params: Record<string, unknown>) {
    if (typeof params.requestId !== "string") throw new Error("Overview interception has no request ID.");
    const requestId = params.requestId;
    const url = new URL(String(record(params.request).url));
    const kind = url.pathname.endsWith("/overview") ? "overview" : "organizations";
    if (params.responseStatusCode === undefined) {
      if (kind === "organizations" && organizationFault) {
        if (typeof params.networkId !== "string") throw new Error("Missing organization network witness.");
        const seen: AdminRead = { kind, status: null, rows: -1, total: null, held: false, completed: false, fault: organizationFault };
        requests.push(seen);
        faultedRequests.set(params.networkId, seen);
        if (organizationFault === "connection-reset") {
          await send("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" });
        }
        // For abort, keep the request pending until the user switches tabs and
        // the component's own AbortController cancels it. Network records proof.
        return;
      }
      await send("Fetch.continueRequest", { requestId });
      return;
    }
    const status = Number(params.responseStatusCode);
    const body = record(await send("Fetch.getResponseBody", { requestId }));
    if (typeof body.body !== "string") throw new Error("Missing the original admin response body.");
    const original = record(JSON.parse(body.base64Encoded === true ? Buffer.from(body.body, "base64").toString() : body.body));
    const seen = { kind, status, rows: Array.isArray(original.organizations) ? original.organizations.length : -1,
      total: Number(kind === "overview" ? record(original.summary).totalOrganizations : record(original.page).total),
      held: holding && kind === "overview", completed: false };
    requests.push(seen);
    if (seen.held) {
      await new Promise<void>(resolve => held.set(requestId, resolve));
      held.delete(requestId);
    }
    await send("Fetch.continueResponse", { requestId });
    seen.completed = true;
  }
  socket.addEventListener("message", event => {
    const message = record(JSON.parse(String(event.data)));
    if (typeof message.id === "number") {
      const call = calls.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        calls.delete(message.id);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.resolve(message.result);
      }
    }
    if (message.method === "Network.loadingFailed") {
      const params = record(message.params);
      const seen = faultedRequests.get(String(params.requestId));
      if (seen) {
        seen.networkError = String(params.errorText);
        seen.canceled = params.canceled === true;
        seen.completed = true;
      }
    }
    if (message.method === "Fetch.requestPaused") {
      const task = intercept(record(message.params)).catch((error: unknown) => {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      });
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Overview transport connection timed out.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Overview transport connection failed.")); }, { once: true });
    });
    await send("Network.enable", {});
    await send("Fetch.enable", { patterns: [
      { urlPattern: `${origin}/api/browser/v1/admin/organizations*`, requestStage: "Request" },
      ...["overview", "organizations"].map(path => ({
        urlPattern: `${origin}/api/browser/v1/admin/${path}*`, requestStage: "Response",
      })),
    ] });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    hold() { holding = true; },
    failOrganizations(fault: OrganizationFault) { organizationFault = fault; },
    async cachePresent() {
      const result = record(await send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin: origin, isLocalStorage: false },
      }));
      if (!Array.isArray(result.entries)) throw new Error("Missing admin session-storage witness.");
      return result.entries.some(entry => Array.isArray(entry) && entry[0] === "den-admin-overview-cache");
    },
    async release() {
      holding = false;
      for (const release of held.values()) release();
      await Promise.all(active);
      if (errors[0]) throw errors[0];
    },
    requests() {
      if (errors[0]) throw errors[0];
      return requests.map(request => ({ ...request }));
    },
    async [Symbol.asyncDispose]() {
      holding = false;
      for (const release of held.values()) release();
      await Promise.all(active);
      await send("Fetch.disable", {}).finally(() => socket.close());
    },
  };
}

export async function adminOrganizationRace(seed: Seed) {
  const den = await seed.den({ web: true, org: {
    name: "Admin race first organization", members: { otherOwner: {} },
  }, env: { DEN_DEPLOYMENT: "cloud", DEN_ORG_MODE: "multi_org", RESEND_API_KEY: "", SMTP_HOST: "", SENTRY_DSN: "" } });
  if (!den.database?.name.startsWith("openwork_eval")) throw new Error("Admin race requires an isolated scratch database.");
  const otherOwner = den.members.otherOwner;
  if (!otherOwner) throw new Error("Missing synthetic organization owner.");
  const other = await seed.api(otherOwner, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Admin race second organization" }) });
  if (!other.response.ok) throw new Error("Could not arrange the second synthetic organization.");
  const granted = await seed.api(den.admin, "/v1/admin/admins", {
    method: "POST", body: JSON.stringify({ email: otherOwner.email, note: "Synthetic revocation witness" }),
  });
  if (!granted.response.ok) throw new Error("Could not arrange the second platform admin.");
  const overview = await seed.api(den.admin, "/v1/admin/overview");
  const admins = record(overview.body).admins;
  const browserAdminId = Array.isArray(admins) ? record(admins.find(value => record(value).email === den.admin.email)).id : null;
  if (!overview.response.ok || typeof browserAdminId !== "string") throw new Error("Missing the revocable platform admin.");
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/features", headless: true, viewport: { width: 1440, height: 1100 } });
  // The browser cookie comes from real password sign-in, before any user action.
  const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
    method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  const cookie = signedIn.response.headers.getSetCookie().find(value => value.includes("session_token="))?.split(";")[0] ?? "";
  const separator = cookie.indexOf("=");
  if (!signedIn.response.ok || separator < 1) throw new Error("Could not sign in the synthetic admin browser.");
  const applied = record(await web.client.send("Network.setCookie", {
    name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: den.ref.webUrl,
    path: "/", httpOnly: true, sameSite: "Lax",
  }));
  if (applied.success !== true) throw new Error("Could not apply the server-issued browser cookie.");
  const transport = await overviewTransport(web, new URL(den.ref.webUrl).origin);
  return { web, transport, adminUrl: `${den.ref.webUrl}/admin`, featuresUrl: `${den.ref.webUrl}/admin/features`,
    async revokeAccess(status: 401 | 403) {
      // Mutate only this world's real session/allowlist through supported Den
      // endpoints. Never replace the browser's identity or a denial payload.
      const response = status === 401
        ? await fetch(`${den.ref.apiUrl}/api/auth/sign-out`, {
          // seed.web also installs den.admin's genuine bearer session. Den's
          // sign-out endpoint must revoke both credentials the browser carries.
          method: "POST", headers: { cookie, authorization: `Bearer ${den.admin.token}`, origin: den.ref.webUrl, "content-type": "application/json" },
          body: "{}", signal: AbortSignal.timeout(10_000),
        })
        : (await seed.api(otherOwner, `/v1/admin/admins/${browserAdminId}`, { method: "DELETE" })).response;
      if (response.status !== 200) throw new Error(`Real admin revocation failed: ${response.status}`);
      return response.status;
    },
    async [Symbol.asyncDispose]() { await transport[Symbol.asyncDispose](); } };
}
