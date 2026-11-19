import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Seed } from "@openwork/env";

type ApiId = "drive" | "docs" | "sheets" | "gmail" | "calendar";

const SERVICES: Record<ApiId, { path: RegExp; service: string; title: string }> = {
  drive: { path: /^\/drive\/v3\/about$/, service: "drive.googleapis.com", title: "Google Drive API" },
  docs: { path: /^\/v1\/documents\/[^/]+$/, service: "docs.googleapis.com", title: "Google Docs API" },
  sheets: { path: /^\/v4\/spreadsheets\/[^/]+$/, service: "sheets.googleapis.com", title: "Google Sheets API" },
  gmail: { path: /^\/gmail\/v1\/users\/me\/profile$/, service: "gmail.googleapis.com", title: "Gmail API" },
  calendar: { path: /^\/calendar\/v3\/calendars\/primary\/events$/, service: "calendar-json.googleapis.com", title: "Google Calendar API" },
};
const PROJECT = "123456789";
/** Tall enough that the unchecked settings page fits without scrolling. */
export const VIEWPORT_HEIGHT = 1600;

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Google, as Den sees it, for a connector whose Cloud project has the Docs and Sheets APIs turned off.
 * Only Google is synthetic: Den, its database, the connector setup and the admin's sign-in are real.
 */
async function startGoogle() {
  const off = new Set<ApiId>(["docs", "sheets"]);
  const probes: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://google.local");
    if (url.pathname === "/token") {
      return send(response, 200, {
        access_token: "local-google-access",
        refresh_token: "local-google-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/drive.readonly",
      });
    }
    if (url.pathname === "/userinfo") return send(response, 200, { sub: "local-admin", email: "admin@example.test", name: "Workspace Admin" });
    const api = (Object.keys(SERVICES) as ApiId[]).find((id) => SERVICES[id].path.test(url.pathname));
    if (!api) return send(response, 404, { error: { code: 404, status: "NOT_FOUND" } });
    if (request.headers.authorization !== "Bearer local-google-access") return send(response, 401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    probes.push(api);
    const { service, title } = SERVICES[api];
    if (off.has(api)) {
      return send(response, 403, {
        error: {
          code: 403,
          message: `${title} has not been used in project ${PROJECT} before or it is disabled.`,
          errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
          status: "PERMISSION_DENIED",
          details: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            domain: "googleapis.com",
            metadata: { service, serviceTitle: title, consumer: `projects/${PROJECT}`, activationUrl: `https://console.developers.google.com/apis/api/${service}/overview?project=${PROJECT}` },
          }],
        },
      });
    }
    // Probes ask for an ID no file has, so an API that is on answers "not found".
    if (api === "docs" || api === "sheets") return send(response, 404, { error: { code: 404, status: "NOT_FOUND" } });
    return send(response, 200, { kind: api });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local Google has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    /** An admin turns the API on in the Google Cloud project. */
    turnOn: (api: ApiId) => { off.delete(api); },
    probes: () => [...probes],
    enableUrl: (api: ApiId) => `https://console.developers.google.com/apis/api/${SERVICES[api].service}/overview?project=${PROJECT}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export async function googleConnectorApiCheck(seed: Seed) {
  const google = await startGoogle();
  try {
    const den = await seed.den({
      org: { name: "API check workspace", admin: { name: "Workspace Admin" } },
      env: {
        DEN_GOOGLE_API_BASE_URL: google.url,
        DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${google.url}/authorize`,
        DEN_GOOGLE_OAUTH_TOKEN_URL: `${google.url}/token`,
        DEN_GOOGLE_OAUTH_USERINFO_URL: `${google.url}/userinfo`,
      },
    });
    // The connector an admin adds from the catalog: Calendar, Gmail drafts and Drive reads.
    const connector = await seed.nativeConnector(den.admin, {
      providerKey: "google-workspace",
      name: "Google Workspace",
      clientId: "fixture-client.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
      features: ["calendarRead", "gmailDraft", "driveRead"],
    });
    // The admin signs in with Google on this connector through Den's real callback.
    const started = await seed.api(den.admin, `/v1/oauth-providers/${encodeURIComponent(connector.id)}/connect/start`);
    const authorizeUrl = started.body && typeof started.body === "object" && "authorizeUrl" in started.body ? String(started.body.authorizeUrl) : "";
    if (!started.response.ok || !authorizeUrl) throw new Error(`Connect start failed: ${started.text}`);
    const authorize = new URL(authorizeUrl);
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "approve");
    const connected = await fetch(callback, { redirect: "manual" });
    if (connected.status >= 400) throw new Error(`Connect callback failed: HTTP ${connected.status}`);
    await connected.arrayBuffer();

    const web = await seed.web({
      den,
      signedInAs: den.admin,
      startPath: `/dashboard/mcp-connections/${encodeURIComponent(connector.id)}`,
      headless: true,
      viewport: { width: 1280, height: VIEWPORT_HEIGHT },
    });
    return {
      web,
      turnOn: google.turnOn,
      probes: google.probes,
      enableUrl: google.enableUrl,
      [Symbol.asyncDispose]: google.close,
    };
  } catch (error) { await google.close(); throw error; }
}
