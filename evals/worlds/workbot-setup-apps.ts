import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Den, Seed } from "@openwork/env";
import { denFetch } from "@openwork/behaviors";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { workbotConnectionUrl } from "../../ee/apps/workbot/src/server/routes.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function field(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) value = record(value) ? value[key] : undefined;
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} missing`);
  return value;
}

/** Only the outside Google sign-in is synthetic; Den runs as its ordinary process. */
async function startProvider(handler: (request: IncomingMessage, body: string, response: ServerResponse) => Promise<void>) {
  const server = httpServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      await handler(request, body, response);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider has no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/**
 * W3, Workbot sets up apps: the real Workbot page and Den (identity, the Get set up checklist, connection grants,
 * OAuth callbacks and readiness) with a disposable database. The member already got one answer in this conversation;
 * the runner and Google's consent and token endpoints are local fixtures. Nothing leaves localhost.
 */
export function workbotSetupApps(seed: Seed) { return setupApps(seed, false); }
export function workbotSetupExternalApps(seed: Seed) { return setupApps(seed, true); }

async function setupApps(seed: Seed, external: boolean) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) throw new Error("The setup proof requires a fresh disposable Den, not a reused server.");
  const resources = new AsyncDisposableStack();
  let den: Den | undefined;
  let token = "";
  let organizationId = "";
  let latestAuthorizationState: string | null = null;
  let starts = 0;
  const requestDen = async (accessToken: string | null, method: "GET" | "POST" | "PUT", path: string, options: { body?: unknown; orgId?: string } = {}) => {
    if (!den) throw new Error("Den has not started");
    const result = await denFetch(den.ref, path, { method, redirect: "manual", headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(options.orgId ? { "x-openwork-org-id": options.orgId } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    return { ...result, status: result.response.status, headers: result.response.headers };
  };
  const scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.readonly";
  const provider = await startProvider(async (request, _body, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/authorize") {
      response.setHeader("content-type", "text/html");
      // Constant markup: request data never enters HTML; the two consent fields are copied through input.value.
      response.end(`<!doctype html><html><title>Local provider consent</title><body style="font:16px system-ui;padding:32px"><h1>Connect your account</h1><form action="/consent"><button name="outcome" value="approve">Approve access</button></form><script>
        const form = document.querySelector("form");
        const parameters = new URLSearchParams(location.search);
        for (const name of ["redirect_uri", "state"]) {
          const input = document.createElement("input");
          input.type = "hidden"; input.name = name; input.value = parameters.get(name) || "";
          form.appendChild(input);
        }
      </script></body></html>`);
      return;
    }
    if (url.pathname === "/consent") {
      const target = new URL(text(url.searchParams.get("redirect_uri"), "callback"));
      if (target.origin !== provider.url) throw new Error("Fixture callback left localhost");
      target.searchParams.set("state", text(url.searchParams.get("state"), "state"));
      target.searchParams.set("code", "approve");
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "local-fake-access", expires_in: 3600, token_type: "Bearer", scope }));
      return;
    }
    if (url.pathname === "/userinfo") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ sub: "local-member", email: "avery@acme.example", name: "Avery Owner" })); return; }
    if (url.pathname.startsWith("/v1/oauth-providers/") && den) {
      const result = await requestDen(null, "GET", url.pathname + url.search);
      response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "text/html" }).end(result.text);
      return;
    }
    response.writeHead(404).end();
  });
  resources.defer(() => provider.close());
  try {
    const now = Date.now();
    // One finished answer in the member's conversation: the checklist appears only after one.
    const thread = { available: true, name: "Workbot", organizationName: "Acme", status: "idle", hasEarlier: false, filesEnabled: false, turns: [{
      id: "wb_setup_answer", text: "What changed in the launch plan?", sentAt: now - 60_000, finishedAt: now - 58_000, status: "done",
      attachments: [], parts: [{ kind: "text", text: "The launch moved to Thursday." }], modelSteps: 1, error: null,
    }] };
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)), server: { host: "127.0.0.1", port: 0, strictPort: false }, plugins: [{ name: "workbot-setup-apps", configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        if (!url.pathname.startsWith("/v1/workbot")) return next();
        const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
        if (!den) return json({ error: "not_ready" }, 503);
        if (url.pathname === "/v1/workbot/me") {
          // Who is signed in and which Workbot flags are on come from Den's real Workbot session.
          const session = await requestDen(token, "GET", "/v1/workbot/session");
          if (session.status !== 200) return json(session.body, session.status);
          return json({ name: field(session.body, "user", "name"), email: field(session.body, "user", "email"), userId: field(session.body, "user", "id"), organizationId: field(session.body, "organization", "id"), organizationName: field(session.body, "organization", "name"), enabled: true, calendar: false, documents: false, canSchedule: false, sideChats: false, activationChecklist: field(session.body, "activationChecklist") === true, denUrl: den.ref.webUrl });
        }
        if (url.pathname === "/v1/workbot") return json(thread);
        if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
        if (url.pathname === "/v1/workbot/connections" || url.pathname.endsWith("/connect/start") || url.pathname.startsWith("/v1/workbot/activation")) {
          let body = ""; for await (const chunk of req) body += chunk;
          if (url.pathname.endsWith("/connect/start")) starts++;
          const result = await requestDen(token, req.method === "POST" ? "POST" : "GET", url.pathname + url.search, body ? { body: JSON.parse(body) } : {});
          if (external && url.pathname === "/v1/workbot/connections" && Array.isArray(field(result.body, "connections"))) {
            const connections = field(result.body, "connections");
            if (Array.isArray(connections)) return json({ connections: connections.filter(record).map(connection => ({ ...connection, connectMode: "external", connectUrl: workbotConnectionUrl(den!.ref.webUrl.replace(/\/+$/, ""), organizationId, String(connection.id)) })) });
          }
          if (url.pathname.endsWith("/connect/start")) {
            const authorizeUrl = field(result.body, "authorizeUrl");
            latestAuthorizationState = typeof authorizeUrl === "string" ? new URL(authorizeUrl).searchParams.get("state") : null;
          }
          res.writeHead(result.status, { "content-type": "application/json" }).end(result.text);
          return;
        }
        return json({ error: "not_found" }, 404);
      });
    } }] });
    resources.defer(() => vite.close());
    await vite.listen();
    const workbotUrl = text(vite.resolvedUrls?.local[0], "Workbot URL");
    den = await seed.den({ org: { name: "Acme", admin: { name: "Avery Owner" }, members: {} }, trustedOrigins: [provider.url, workbotUrl], env: { DEN_WORKBOT_URL: workbotUrl, DEN_API_PUBLIC_URL: provider.url, DEN_GOOGLE_API_BASE_URL: provider.url, DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`, DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`, DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo`, DEN_ALLOW_PRIVATE_MCP_URLS: "true", DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", SMTP_HOST: "", LOOPS_API_KEY: "", STRIPE_SECRET_KEY: "" } });
    const owner = den.admin;
    organizationId = await seededOrganizationId(seed, owner);
    if (!organizationId) throw new Error("The seeded organization is missing.");
    const configured = await requestDen(owner.token, "POST", "/v1/oauth-providers/google-workspace/client", { orgId: organizationId, body: { clientId: "fixture-client", clientSecret: "fixture-secret", features: ["driveRead", "calendarRead"] } });
    if (configured.status !== 200) throw new Error(configured.text);
    const issued = await requestDen(owner.token, "POST", "/v1/mcp/token", { orgId: organizationId, body: { scopes: ["mcp:read", "mcp:write"] } });
    token = text(field(issued.body, "token"), "Workbot token");
    // Workbot's token stays in Acme while the browser's Den session starts in another workspace.
    const other = await requestDen(owner.token, "POST", "/v1/org", { body: { name: "Other team" } });
    if (other.status !== 200 && other.status !== 201) throw new Error(other.text);
    const otherOrganizationId = text(field(other.body, "organization", "id"), "Other workspace");
    const selected = await requestDen(owner.token, "POST", "/v1/me/active-organization", { body: { organizationId: otherOrganizationId } });
    if (selected.status !== 200) throw new Error(selected.text);
    const web = await seed.web({ den, signedInAs: owner, startPath: "/dashboard/members", headless: true });
    const clients: Array<{ close(): void }> = [];
    resources.defer(() => { for (const client of clients) client.close(); });
    const denWeb = den.ref.webUrl.replace(/\/+$/, "");
    return {
      web, url: workbotUrl, organizationId, otherOrganizationId, starts: () => starts,
      person: { email: owner.email, password: owner.password },
      modelConfig: JSON.stringify({ id: "fixture-provider", name: "Fixture provider", npm: "@ai-sdk/openai-compatible", env: ["FIXTURE_API_KEY"], api: `${provider.url}/v1`, models: [{ id: "fixture-model", name: "Fixture Model", attachment: false, reasoning: false, tool_call: true, structured_output: true, temperature: true, release_date: "2026-01-01", last_updated: "2026-01-01", open_weights: false, limit: { context: 128000, input: 128000, output: 8192 }, modalities: { input: ["text"], output: ["text"] } }] }),
      async savedProviders() {
        const result = await requestDen(owner.token, "GET", "/v1/llm-providers?scope=manageable", { orgId: organizationId });
        const list = field(result.body, "llmProviders");
        return Array.isArray(list) ? list.filter(record).map(item => {
          const members = field(item, "access", "members");
          return { name: item.name, hasApiKey: item.hasApiKey, allMembers: field(item, "access", "allMembers"), memberCount: Array.isArray(members) ? members.length : 0 };
        }) : [];
      },
      async activeOrganizationId() {
        const result = await requestDen(owner.token, "GET", "/v1/me/orgs");
        return field(result.body, "activeOrgId");
      },
      /** The exact Den page a step opens, in the signed-in workspace. */
      denPage: (path: string) => `${denWeb}/dashboard/${path}${path.includes("?") ? "&" : "?"}workbotOrganizationId=${encodeURIComponent(organizationId)}`,
      /** What Den reports for the member (a read with their Workbot token). */
      async activation() {
        const result = await requestDen(token, "GET", "/v1/workbot/activation");
        const raw = field(result.body, "steps");
        const steps = Array.isArray(raw) ? raw.filter(record) : [];
        return { status: result.status, done: steps.filter((step) => step.done === true).map((step) => String(step.id)) };
      },
      async ready() {
        const result = await requestDen(token, "GET", "/v1/workbot/connections");
        const connections = field(result.body, "connections");
        return Array.isArray(connections) && connections.some((connection) => record(connection) && connection.ready === true);
      },
      /** Attach only to the provider window the member's click opened. No page state is read or written. */
      async consent(): Promise<Surface> {
        const targets = await listTargets(web.handle.cdpUrl);
        const target = targets.find(entry => entry.type === "page" && entry.url.startsWith(`${provider.url}/authorize`) && new URL(entry.url).searchParams.get("state") === latestAuthorizationState);
        if (!target) throw new Error("The provider consent window did not open");
        const client = await connect(debuggerUrlFor(web.handle.cdpUrl, target));
        await client.send("Page.enable");
        clients.push(client);
        return { handle: { ...web.handle, name: "local-provider-consent" }, client };
      },
      /** Follow the real tab opened by Invite, including after Den consumes the workspace hint. */
      async membersPage(): Promise<Surface> {
        const targets = await listTargets(web.handle.cdpUrl);
        const target = targets.find(entry => entry.type === "page" && entry.url.startsWith(`${denWeb}/dashboard/members`));
        if (!target) throw new Error("Invite did not open the Members page");
        const client = await connect(debuggerUrlFor(web.handle.cdpUrl, target));
        await client.send("Page.enable");
        clients.push(client);
        return { handle: { ...web.handle, name: "workbot-invite-members" }, client };
      },
      async denTab(path: string): Promise<Surface> {
        const target = (await listTargets(web.handle.cdpUrl)).find(entry => entry.type === "page" && entry.url.startsWith(`${denWeb}/dashboard/${path}`));
        if (!target) throw new Error(`The ${path} page did not open`);
        const client = await connect(debuggerUrlFor(web.handle.cdpUrl, target));
        await client.send("Page.enable");
        clients.push(client);
        return { handle: { ...web.handle, name: "workbot-setup-destination" }, client };
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
