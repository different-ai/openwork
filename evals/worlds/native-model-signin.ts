import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { denForAppWeb } from "./signed-in-app-web.ts";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";
import { modelRemovalHttpFixture, HttpFixtureReply } from "./model-removal-cdp.ts";
import { fixtureOAuthClientId, fixtureOAuthClientSecret, modelProviderOAuthFixture } from "./model-provider-oauth-fixture.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, label: string) { if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`); return value; }
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Real native premise did not become ready: ${label}`);
}

/** Real Den OAuth state/PKCE/RS256 checks, host registration, sync owner and
 * shipping native engine. Mocked edges are only external provider HTTP and an
 * explicitly failed browser catalog read. No auth/store/outcome/native setter. */
async function nativeModelSignIn(seed: Seed, live: boolean) {
  await using setup = new AsyncDisposableStack();
  const late: Array<() => void | Promise<void>> = [];
  const preload = seed.tmpPath("native-provider-http.mjs");
  const provider = setup.use(await modelProviderOAuthFixture(preload));
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Provider sign-in", members: { member: { name: "Model Member" }, other: { name: "Other Member" } } },
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: provider.origin, GATEWAY_PUBLIC_BASE_URL: provider.origin,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const initialPolicy = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT", body: JSON.stringify({ capabilities: { liveProviderSync: false } }),
  });
  if (!initialPolicy.response.ok) throw new Error("Could not arrange the real server-owned baseline");
  const member = den.members.member; const other = den.members.other;
  if (!member || !other) throw new Error("Missing real seeded members");
  const org = await seed.api(den.admin, "/v1/org");
  const members = record(org.body) && Array.isArray(org.body.members) ? org.body.members.filter(record) : [];
  const memberRow = members.find(item => record(item.user) && item.user.name === "Model Member");
  const memberId = text(memberRow?.id, "member ID");
  async function create(name: string, providerId: string, modelId: string | null, oauth: boolean) {
    const response = await seed.api(den.admin, "/v1/inference-providers", { method: "POST", body: JSON.stringify({
      name, providerId, modelIds: modelId ? [modelId] : [], memberIds: [memberId],
      ...(oauth ? { credentialMode: "member", oauthClientId: fixtureOAuthClientId, oauthClientSecret: fixtureOAuthClientSecret,
        settings: { project: "fixture-project", location: "us-central1" } }
        : { credential: { kind: "api_key", secret: "synthetic-baseline-key" } }),
    }) });
    const value = record(response.body) && record(response.body.inferenceProvider) ? response.body.inferenceProvider : null;
    if (!response.response.ok || !value) throw new Error(`Creating ${name} failed: HTTP ${response.response.status} ${response.text.slice(0, 300)}`);
    const sets = Array.isArray(value.credentialSets) ? value.credentialSets.filter(record) : [];
    return { id: text(value.id, "provider ID"), setId: text(sets[0]?.id, "credential set") };
  }
  const baseline = await create("Baseline provider", "openai", "gpt-4o-mini", false);
  // Vertex Anthropic uses real Google member OAuth, then the Anthropic native
  // adapter that the pinned host supports. This does not claim Gemini SDK support.
  // Select an actual returned catalog alias instead of inventing an upstream ID.
  const target = await create("Member provider", "google-vertex-anthropic", null, true);
  const memberRead = async (path: string) => {
    const response = await fetch(`${den.ref.apiUrl}${path}`, { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": organizationId }, cache: "no-store" });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`Member read ${path}: HTTP ${response.status}`);
    return body;
  };
  const inventory = await memberRead("/v1/inference-providers?scope=usable");
  if (!record(inventory) || !Array.isArray(inventory.inferenceProviders)) throw new Error("Missing real pending inventory");
  const granted = inventory.inferenceProviders.filter(record);
  const baselineProvider = granted.find(item => item.id === baseline.id);
  const targetProvider = granted.find(item => item.id === target.id);
  const baselineModels = baselineProvider && Array.isArray(baselineProvider.models) ? baselineProvider.models.filter(record) : [];
  const requests = targetProvider && Array.isArray(targetProvider.authorizationRequests) ? targetProvider.authorizationRequests.filter(record) : [];
  const request = requests.find(item => item.credentialSetId === target.setId);
  const pending = request && Array.isArray(request.models) ? request.models.filter(record) : [];
  const targetModel = { providerID: target.id, modelID: text(pending[0]?.id, "real pending alias"), name: text(pending[0]?.name, "real pending name") };
  const baselineModel = { providerID: baseline.id, modelID: text(baselineModels[0]?.id, "baseline alias") };
  const hostToken = randomBytes(32).toString("hex");
  const app = await seed.appWeb({ den: den.ref, webPort, engine: "v2", headless: true, mouse: true,
    name: live ? "native-live-model-signin" : "native-server-model-signin", workspacePath: seed.tmpPath("native-model-signin"),
    env: { OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken, OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "600000",
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}) },
  });
  await seed.signIn(app, member, "member");
  const session = await seed.session(app, { title: "Provider sign-in request" });
  const navigation = await app.client.send("Page.getNavigationHistory");
  const entry = record(navigation) && Array.isArray(navigation.entries) && typeof navigation.currentIndex === "number" ? navigation.entries[navigation.currentIndex] : null;
  const sessionUrl = record(entry) ? text(entry.url, "conversation URL") : "";
  const workspaceId = new URL(sessionUrl).pathname.match(/\/workspace\/([^/]+)/)?.[1];
  if (!workspaceId || !sessionUrl.includes(session.sessionId)) throw new Error("The real native session destination is missing");
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
  const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!manifest) throw new Error("Owned host manifest missing");
  const host = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${app.openworkUrl}${path}`, { method, headers: { authorization: `Bearer ${manifest.token}`, "x-openwork-host-token": manifest.hostToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const payload = await response.text();
    const value: unknown = payload ? JSON.parse(payload) : null;
    if (!response.ok) throw new Error(`Real host ${method} ${path}: HTTP ${response.status}`);
    return value;
  };
  // Initialize pending authorization through the genuine legacy owner. Live's
  // tested premise is the supported running-owner transition, not a forged row.
  await host("/den-session", "PUT", { baseUrl: den.ref.apiUrl, token: member.token, orgId: organizationId });
  await host("/cloud-provider-sync/run", "POST", { reason: "manual" });
  await until(() => host("/cloud-provider-sync/status"), value => record(value) && Array.isArray(value.skippedProviders)
    && value.skippedProviders.some(item => record(item) && item.cloudProviderId === target.id && item.credentialSetId === target.setId), "real pending OAuth provider");
  if (live) {
    await enableOrganizationCapabilities(seed, den.admin, { liveProviderSync: true }, organizationId);
    await host("/managed-policy");
    await host("/experimental/engine-v2-preview", "PUT", { enabled: false });
    await host("/experimental/engine-v2-preview", "PUT", { enabled: true, chatRouting: true });
  }
  const owner = await until(() => host("/experimental/engine-v2-preview/status"), value => record(value)
    && value.running === true && value.chatRouting === true && value.liveProviderSync === live, "effective native sync owner");
  const nativeInfo = await host(`/workspace/${workspaceId}/opencode2/api/info`);
  const info = record(nativeInfo) && record(nativeInfo.data) ? nativeInfo.data : nativeInfo;
  const nativeVersion = record(info) ? text(info.version, "native engine version") : "";
  if (!nativeVersion.includes("2.0.26")) throw new Error(`The real native engine is not the supported pinned version: ${nativeVersion}`);
  // Seed only an authentic browser cookie issued by the same real Den login.
  // No app store, token response, OAuth callback or native catalog is replaced.
  const browserLogin = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ email: member.email, password: member.password }) });
  if (!browserLogin.ok) throw new Error(`Real browser session login failed: HTTP ${browserLogin.status}`);
  const cookies = browserLogin.headers.getSetCookie();
  if (!cookies.length) throw new Error("The real Den did not issue a browser cookie");
  for (const cookie of cookies) {
    const pair = cookie.split(";", 1)[0] ?? ""; const at = pair.indexOf("=");
    if (at <= 0) continue;
    const result = await app.client.send("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: den.ref.webUrl,
      httpOnly: /;\s*httponly(?:;|$)/i.test(cookie), secure: /;\s*secure(?:;|$)/i.test(cookie), path: "/" });
    if (!record(result) || result.success !== true) throw new Error("Could not deliver the authentic Den browser cookie");
  }
  let failCatalog = false; let failedReads = 0; let oauthStarts = 0;
  const nativePath = `/workspace/${workspaceId}/opencode2/api/model`;
  const edge = setup.use(await modelRemovalHttpFixture(app, ["*/opencode2/api/model*", "*/cloud-provider-sync/providers/*/oauth/start"], url => {
    if (failCatalog && url.pathname.endsWith("/opencode2/api/model")) { failedReads++; return new HttpFixtureReply(503, [{ name: "content-type", value: "application/json" },
      { name: "access-control-allow-origin", value: new URL(app.webUrl).origin }, { name: "access-control-allow-credentials", value: "true" }], JSON.stringify({ error: "fixture_catalog_unavailable" })); }
    return undefined;
  }, request => { if (request.method === "POST" && new URL(request.url).pathname.endsWith("/oauth/start")) oauthStarts++; }));
  let tab: Surface | undefined;
  const resources = setup.move();
  return { app, den, other, organizationId, sessionUrl, sessionId: session.sessionId, targetModel, baselineModel, live, owner, nativeVersion,
    row(model: { providerID: string; modelID: string }) { return `[data-testid="composer-model-picker"] [data-model-key="${model.providerID}:${model.modelID}"]`; },
    async consentTab() {
      edge.check();
      if (tab) return tab;
      const targetTab = (await listTargets(app.handle.cdpUrl)).find(item => item.type === "page" && item.id !== app.client.targetId
        && item.url.startsWith(den.ref.webUrl) && new URL(item.url).pathname === "/gateway/connect");
      if (!targetTab) return undefined;
      tab = { handle: app.handle, client: await connect(debuggerUrlFor(app.handle.cdpUrl, targetTab)) };
      const redirect = await modelRemovalHttpFixture({ client: tab.client, webUrl: den.ref.webUrl }, ["https://accounts.google.com/o/oauth2/v2/auth*"], url =>
        new HttpFixtureReply(302, [{ name: "location", value: provider.authorizationRedirect(url) }, { name: "cache-control", value: "no-store" }]));
      late.push(() => redirect[Symbol.asyncDispose]()); late.push(() => tab?.client.close());
      return tab;
    },
    failCurrentCatalog(value: boolean) { edge.check(); failCatalog = value; },
    async nativeHasRequestedModel() {
      const value = await host(nativePath);
      const items = Array.isArray(value) ? value : record(value) && Array.isArray(value.data) ? value.data : null;
      if (!items) throw new Error("Real native model response was malformed");
      return items.some(item => record(item) && item.providerID === targetModel.providerID && item.id === targetModel.modelID);
    },
    async memberAuthorizationReady() {
      const value = await memberRead("/v1/inference-providers?scope=usable");
      const items = record(value) && Array.isArray(value.inferenceProviders) ? value.inferenceProviders.filter(record) : [];
      const item = items.find(value => value.id === target.id);
      return Boolean(item && Array.isArray(item.models) && item.models.some(model => record(model) && model.id === targetModel.modelID)
        && Array.isArray(item.authorizationRequests) && !item.authorizationRequests.some(value => record(value) && value.credentialSetId === target.setId));
    },
    async diagnostics() {
      const status = await host("/experimental/engine-v2-preview/status");
      const inventory = await memberRead("/v1/inference-providers?scope=usable");
      const providers = record(inventory) && Array.isArray(inventory.inferenceProviders) ? inventory.inferenceProviders.filter(record) : [];
      const requested = providers.find(item => item.id === target.id);
      return { nativeVersion, liveOwner: record(status) ? status.liveProviderSync : null,
        skippedProviderIds: record(status) ? status.skippedProviderIds : null,
        mirroredProviderIds: record(status) ? status.mirroredProviderIds : null,
        projectedSdk: requested && record(requested.providerConfig) ? requested.providerConfig.npm : null,
        nativeHasRequestedModel: await this.nativeHasRequestedModel(), ...provider.witness(), failedReads, oauthStarts };
    },
    witness() { edge.check(); return { ...provider.witness(), failedReads, oauthStarts }; },
    async [Symbol.asyncDispose]() { for (const cleanup of late.reverse()) await cleanup(); await resources.disposeAsync(); },
  };
}
export function serverOwnedModelSignIn(seed: Seed) { return nativeModelSignIn(seed, false); }
export function liveOwnedModelSignIn(seed: Seed) { return nativeModelSignIn(seed, true); }
