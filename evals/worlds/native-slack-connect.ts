import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError, type Place, type Seed } from "@openwork/env";
import { slackFixtureClientId, slackFixtureClientSecret, startNativeSlackFixture } from "../packages/labs/src/mock-native-slack.ts";
import { slackIncomplete, slackLimited, slackResultObjects, slackSearchHits, startNativeSlackModel } from "../packages/labs/src/native-slack-model.ts";

export const nativeSlackPrompts = {
  first: "Find the Amber launch discussion in Slack, include my private conversations and direct messages, and read a short thread excerpt with source links.",
  second: "Find the Amber launch discussion in my Slack account and summarize a short thread excerpt with source links.",
  partial: "Find the Amber launch discussion using my remaining Slack access and explain which conversations were not searched.",
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a native Slack response object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a native Slack response string");
  return value;
}
function rpc(raw: string): Record<string, unknown> {
  const line = raw.split("\n").find(entry => entry.startsWith("data:"));
  const envelope = object(JSON.parse(line ? line.slice(5) : raw));
  if (envelope.error) throw new Error("Cloud MCP returned a protocol error");
  return object(envelope.result);
}

/**
 * Browser-representable desktop UX with real app/server/engine and hosted
 * Connect and /admin. Only Slack OAuth/API and inference are synthetic. No BYO
 * connector is created. One Cloud Den keeps the same database and member grants
 * while the platform admin changes the generated, shared feature controls.
 */
export async function nativeSlackConnect(seed: Seed, { place }: { place: Place }) {
  // The native HTTP fixture is loopback, unlike mcpMock's remote transport.
  // Do not silently run a Daytona world against the developer's local server.
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL) {
    throw new SkipError("isolated co-located native Slack HTTP fixture; testkit has no Daytona native-provider transport");
  }
  // The build manifest supplies the independent version pin, not a synthesized runtime result.
  const versions = object(JSON.parse(await readFile(new URL("../../constants.json", import.meta.url), "utf8")));
  const engine = resolveEvalEngine();
  const engineVersion = text(versions[engine === "v2" ? "opencodeV2Version" : "opencodeVersion"]);
  await using setup = new AsyncDisposableStack();
  const slack = setup.use(await startNativeSlackFixture());
  const model = setup.use(await startNativeSlackModel(Object.values(nativeSlackPrompts)));
  const preload = new URL("../packages/labs/src/native-slack-egress.mjs", import.meta.url);
  const den = await seed.den({ web: true, org: {
    name: "ENG-76 synthetic Cloud", members: { first: {}, second: {}, otherOwner: {} },
  }, env: {
    NODE_OPTIONS: `--import=${preload.href}`, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
    DEN_DEPLOYMENT: "cloud", DEN_ORG_MODE: "multi_org",
    RESEND_API_KEY: "", SMTP_HOST: "", SENTRY_DSN: "", DEN_SLACK_SIGNING_SECRET: "",
    // Do not inherit an operator lock: this world proves the fresh registry
    // default and platform-admin overrides, not deployment configuration.
    ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("DEN_FEATURE_")).map(key => [key, ""])),
    DEN_FEATURE_NATIVE_SLACK: "", DEN_FEATURE_SLACK_ASSISTANT: "",
    DEN_SLACK_CLIENT_ID: slackFixtureClientId, DEN_SLACK_CLIENT_SECRET: slackFixtureClientSecret,
    DEN_SLACK_API_BASE_URL: slack.apiUrl, DEN_SLACK_OAUTH_AUTHORIZE_URL: slack.authorizeUrl, DEN_SLACK_OAUTH_TOKEN_URL: slack.tokenUrl,
  } });
  if (!den.database?.name.startsWith("openwork_eval")) {
    throw new Error("Synthetic Slack requires the testkit-owned scratch database; refusing a shared database");
  }
  const organization = object(object((await seed.api(den.admin, "/v1/org")).body).organization);
  const organizationId = text(organization.id);
  const first = den.members.first;
  const second = den.members.second;
  const otherOwner = den.members.otherOwner;
  if (!first || !second || !otherOwner) throw new Error("All synthetic member sessions must be provisioned");
  // seed.den allowlists ONLY den.admin. An ordinary member creates and owns B;
  // an organization owner is not silently made a platform administrator.
  const other = await seed.api(otherOwner, "/v1/org", { method: "POST", body: JSON.stringify({ name: "ENG-76 second Cloud organization" }) });
  if (!other.response.ok) throw new Error("Could not arrange the second synthetic organization");
  const otherOrganization = object(object(other.body).organization);
  const otherOrganizationId = text(otherOrganization.id);
  const active = await seed.api(otherOwner, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId: otherOrganizationId }),
  });
  if (!active.response.ok) throw new Error("Could not select the other owner's organization");
  slack.allowCallbackOrigin(den.ref.webUrl);
  const sessions = { first, second, other: otherOwner };
  const orgFor = (identity: keyof typeof sessions) => identity === "other" ? otherOrganizationId : organizationId;
  const memberRequest = async (identity: keyof typeof sessions, path: string, method = "GET", body?: unknown) => {
    const session = sessions[identity];
    const result = await denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgFor(identity) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { status: result.response.status, body: result.body, text: result.text };
  };
  async function mint(identity: keyof typeof sessions): Promise<DenSession> {
    const result = await memberRequest(identity, "/v1/mcp/token", "POST", { scopes: ["mcp:read"] });
    if (result.status !== 200) throw new Error(`Synthetic member MCP mint failed: ${result.status}`);
    const minted = object(result.body);
    if (!Array.isArray(minted.scopes) || minted.scopes.length !== 1 || minted.scopes[0] !== "mcp:read") {
      throw new Error("The proof requires an actually minted mcp:read-only token");
    }
    return { ...sessions[identity], token: text(minted.token) };
  }
  // Distinct, member-owned, audience-valid read-only tokens; never a shared
  // organization read token. The same tokens are replayed after each UI change.
  const tokens = { first: await mint("first"), second: await mint("second"), other: await mint("other") };
  const viewport = { width: 1440, height: 1400 };
  const adminWeb = await seed.web({ den, signedInAs: den.admin, startPath: "/admin", headless: true, viewport });
  const otherWeb = await seed.web({ den, signedInAs: otherOwner, startPath: "/admin", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: first, startPath: "/dashboard/your-connections", headless: true, viewport });
  const signedOutWeb = await seed.web({ den, startPath: "/login", headless: true, viewport });
  const revokedWeb = await seed.web({ den, signedInAs: first, startPath: "/dashboard/your-connections", headless: true, viewport });
  // Independent browser sign-in, not identity derived from the OAuth URL or
  // desktop bearer. Reuse the gateway browser-OAuth world's real sign-in seam.
  const signInBrowser = async (surface: Surface, session: DenSession, activeOrganizationId = organizationId) => {
    const signedIn = await seed.api(session, "/api/auth/sign-in/email", {
      method: "POST", body: JSON.stringify({ email: session.email, password: session.password }),
    });
    const cookie = signedIn.response.headers.getSetCookie().find(value => value.includes("session_token="))?.split(";")[0] ?? "";
    const separator = cookie.indexOf("=");
    if (!signedIn.response.ok || separator < 1) throw new Error("Could not arrange an independently signed-in Den browser");
    const browserSession = { ...session, token: text(object(signedIn.body).token) };
    const selected = await seed.api(browserSession, "/v1/me/active-organization", {
      method: "POST", body: JSON.stringify({ organizationId: activeOrganizationId }),
    });
    if (!selected.response.ok) throw new Error("Could not select the browser session's organization");
    const applied = object(await surface.client.send("Network.setCookie", {
      name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: den.ref.webUrl,
      path: "/", httpOnly: true, sameSite: "Lax",
    }));
    if (applied.success !== true) throw new Error("Could not install the server-issued browser session cookie");
    return cookie;
  };
  const revocableCookie = await signInBrowser(revokedWeb, first);
  await signInBrowser(adminWeb, den.admin);
  await signInBrowser(otherWeb, otherOwner, otherOrganizationId);
  await signInBrowser(memberWeb, first);
  const makeApp = async (identity: "first" | "second") => {
    const directory = seed.tmpPath(`native-slack-${identity}`);
    await mkdir(directory, { recursive: true });
    const workspacePath = await realpath(directory);
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
      permission: { skill: "allow" }, model: "opencode/big-pickle", small_model: "opencode/big-pickle",
      provider: { opencode: { npm: "@ai-sdk/openai-compatible", options: { baseURL: model.url, apiKey: "synthetic-model-key" }, whitelist: ["big-pickle"],
        models: { "big-pickle": { name: "Big Pickle", tool_call: true, provider: { npm: "@ai-sdk/openai-compatible", api: model.url } } } } },
      mcp: { "openwork-cloud": { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, oauth: false, enabled: true, headers: { Authorization: `Bearer ${tokens[identity].token}` } } },
    }));
    const app = await seed.appWeb({ name: `native-slack-${identity}`, workspacePath, headless: true, env: {
      // Handoff alone permits cross-origin exchange. Ordinary authenticated
      // browser requests use the existing same-origin Vite proxy, not wider CORS.
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1",
      OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl,
      VITE_DEN_API_BASE_URL: "/api/den",
      OPENCODE_MODELS_URL: `${model.url}/models`,
      // The isolated app runtime drops ambient package-manager settings.
      ...(process.env.pnpm_config_verify_deps_before_run ? { pnpm_config_verify_deps_before_run: process.env.pnpm_config_verify_deps_before_run } : {}),
      ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    } });
    await app.client.send("Network.enable");
    await app.client.send("Network.setBlockedURLs", { urls: ["*://slack.com/*", "*://*.slack.com/*"] });
    await seed.signIn(app, sessions[identity], identity);
    await signInBrowser(app, sessions[identity]);
    const workspace = await seed.workspace(app, workspacePath);
    // App-web has no Electron desktopApi bridge. Reuse the owned-runtime public
    // HTTP witness used by engine-parity; this token never enters prompts/evidence.
    const runtimePaths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const manifest = await readHeadlessRuntimeManifest(runtimePaths.runtimeManifestPath);
    if (!manifest) throw new Error("Missing the test-owned app runtime manifest");
    const ownerResponse = await fetch(`${app.openworkUrl}/tokens`, {
      method: "POST", redirect: "error", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "owner", label: "eng-76-runtime-witness" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (ownerResponse.status !== 201) throw new Error("Could not authorize the test-owned runtime witness");
    const ownerToken = text(object(await ownerResponse.json()).token);
    const request = async (path: string) => {
      const response = await fetch(`${app.openworkUrl}${path}`, {
        headers: { Authorization: `Bearer ${ownerToken}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    };
    return { app, workspace, request };
  };
  const memberOne = await makeApp("first");
  const memberTwo = await makeApp("second");
  const attached = new Set<string>();
  let rpcId = 0;
  const resources = setup.move();
  return {
    app: memberOne.app, secondApp: memberTwo.app, adminWeb, otherWeb, memberWeb, signedOutWeb, revokedWeb,
    slack, model, engine, engineVersion, first: sessions.first, second: sessions.second,
    organizationId, otherOrganizationId, organizationSlug: text(organization.slug), otherOrganizationSlug: text(otherOrganization.slug),
    adminUrl: `${den.ref.webUrl}/admin`, featuresUrl: `${den.ref.webUrl}/admin/features`, connectionsUrl: `${den.ref.webUrl}/dashboard/your-connections`,
    workspaceId: memberOne.workspace.workspaceId, secondWorkspaceId: memberTwo.workspace.workspaceId,
    memberRequest, searchHits: slackSearchHits, incomplete: slackIncomplete, limited: slackLimited, objects: slackResultObjects,
    async organizationFeatures(organizationId: string) {
      const result = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        headers: { authorization: `Bearer ${den.admin.token}` },
      });
      if (!result.response.ok) throw new Error(`Admin feature observation failed: ${result.response.status}`);
      return object(result.body);
    },
    async submitRetiredConnectOverride(organizationId: string) {
      // Compatibility probe, not a rollout action: the retired key must be
      // accepted and ignored, without disabling Connect or changing Slack.
      const result = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT",
        headers: { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" },
        body: JSON.stringify({ capabilities: { mcpConnections: false } }),
      });
      return { status: result.response.status, body: result.body };
    },
    async globalSlackFeature() {
      const result = await denFetch(den.admin, "/v1/admin/features", { headers: { authorization: `Bearer ${den.admin.token}` } });
      if (!result.response.ok) throw new Error(`Admin rollout observation failed: ${result.response.status}`);
      return slackResultObjects(result.body).find(entry => entry.key === "nativeSlack");
    },
    async confirmAdminKill() {
      // User has clicked the real destructive control. Testkit has no native
      // dialog action; CDP accepts that browser confirmation, without replacing
      // window.confirm or calling the feature API on the user's behalf.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await adminWeb.client.send("Page.handleJavaScriptDialog", { accept: true });
          return;
        } catch (error) {
          if (!(error instanceof Error) || !/No dialog is showing/i.test(error.message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      throw new Error("The platform-admin kill control did not open its browser confirmation");
    },
    prompt: nativeSlackPrompts,
    appRequest(identity: "first" | "second", path: string) {
      return (identity === "first" ? memberOne : memberTwo).request(path);
    },
    appUrl: new URL(`#/workspace/${memberOne.workspace.workspaceId}/session`, memberOne.app.webUrl).toString(),
    secondAppUrl: new URL(`#/workspace/${memberTwo.workspace.workspaceId}/session`, memberTwo.app.webUrl).toString(),
    async connection(identity: keyof typeof sessions) {
      const result = await memberRequest(identity, "/v1/mcp-connections?scope=usable");
      if (result.status !== 200) throw new Error(`Native connection list failed: ${result.status}`);
      return slackResultObjects(result.body).find(entry => entry.id === "slack");
    },
    async oauthSurface(app: Surface): Promise<Surface> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const target = (await listTargets(app.handle.cdpUrl)).find(entry => entry.type === "page" && !attached.has(entry.id) && entry.url.startsWith(slack.authorizeUrl));
        if (target) {
          attached.add(target.id);
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          resources.defer(() => client.close());
          return { handle: app.handle, client };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Connect did not open an observable loopback Slack OAuth page; no real provider was contacted");
    },
    async callbackTransportBoundaries() {
      const callback = `${den.ref.webUrl}/oauth/slack/callback`;
      const method = await fetch(callback, { method: "POST", body: "", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const duplicate = await fetch(`${callback}?state=one&state=two`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const generic = await fetch(`${den.ref.webUrl}/api/browser/v1/me`, {
        headers: { origin: slack.origin, "sec-fetch-site": "cross-site", authorization: `Bearer ${first.token}` },
        redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
      return { method: method.status, duplicate: duplicate.status, generic: generic.status, genericBody: await generic.text() };
    },
    async revokeAuthorizingBrowserSession() {
      // Real sign-out deletes only this extra browser session. The member's
      // desktop and other Den browser sessions remain independent and valid.
      const response = await fetch(`${den.ref.apiUrl}/api/auth/sign-out`, {
        method: "POST", headers: { cookie: revocableCookie, origin: den.ref.webUrl, "content-type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(10_000),
      });
      return response.status;
    },
    async replayUnsignedCallbackWithBearer() {
      // Observe the test-owned browser's completed callback without putting its
      // code/state into evidence, then test that a bearer cannot replace cookies.
      const history = object(await signedOutWeb.client.send("Page.getNavigationHistory"));
      if (!Array.isArray(history.entries) || typeof history.currentIndex !== "number") throw new Error("Missing callback navigation");
      const current = object(history.entries[history.currentIndex]);
      const callback = new URL(text(current.url));
      if (callback.origin !== new URL(den.ref.webUrl).origin || callback.pathname !== "/oauth/slack/callback") throw new Error("Not the test-owned callback");
      const response = await fetch(`${den.ref.apiUrl}/v1/oauth-providers/slack/connect/callback${callback.search}`, {
        headers: { authorization: `Bearer ${first.token}` }, redirect: "manual", signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, text: await response.text() };
    },
    async startAuthorization(identity: keyof typeof sessions) {
      const started = await memberRequest(identity, "/v1/oauth-providers/slack/connect/start");
      if (started.status !== 200) throw new Error(`Native OAuth start failed: ${started.status}`);
      const authorizeUrl = new URL(text(object(started.body).authorizeUrl));
      if (authorizeUrl.origin !== slack.origin) throw new Error("Refusing a non-synthetic Slack authorization URL");
      return authorizeUrl.toString();
    },
    async mcp(identity: keyof typeof sessions, name: string, args: Record<string, unknown>) {
      const session = tokens[identity];
      const result = await denFetch(session, "/mcp/agent", { method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(30_000) });
      return { status: result.response.status, body: result.response.ok ? rpc(result.text) : result.body };
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
