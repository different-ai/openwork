import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix as path } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function readDesktopProfile(read = readFile) {
  const root = "/opt/openwork-preview/desktop";
  const profile = JSON.parse(await read(`${root}/profile.json`, "utf8"));
  if (typeof profile.rootPath !== "string" || !/^\/opt\/openwork-preview\/desktop\/openwork-test-profile-[A-Za-z0-9]+$/.test(profile.rootPath)
    || profile.userDataPath !== `${profile.rootPath}/electron/user-data`
    || !profile.environment || !["HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR", "OPENWORK_ENV_STORE"].every((key) => typeof profile.environment[key] === "string") || !Object.values(profile.environment).every((value) => typeof value === "string" && value.startsWith(`${profile.rootPath}/`) && path.normalize(value) === value)
    || profile.environment.OPENWORK_DESKTOP_BOOTSTRAP_PATH !== `${profile.rootPath}/openwork/config/desktop-bootstrap.json`
    || profile.environment.OPENWORK_SERVER_CONFIG !== `${profile.rootPath}/openwork/config/server.json`) throw new Error("Invalid isolated desktop profile");
  async function optional(file) {
    try { return JSON.parse(await read(file, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  }
  const expectedWorkspacePath = `${profile.userDataPath}/openwork-dev-data/home/OpenWork Chat`;
  const registry = await optional(`${profile.userDataPath}/openwork-workspaces.json`);
  const server = await optional(profile.environment.OPENWORK_SERVER_CONFIG);
  const validRegistry = (value) => Array.isArray(value?.workspaces) && value.workspaces.length === 1
    && value.workspaces.every((workspace) => workspace.path === expectedWorkspacePath && (workspace.workspaceType ?? "local") === "local"
      && (workspace.preset ?? "starter") === "starter" && (workspace.name ?? "OpenWork Chat") === "OpenWork Chat"
      && (workspace.displayName ?? "OpenWork Chat") === "OpenWork Chat" && !workspace.baseUrl && !workspace.openworkHostUrl && !workspace.openworkToken);
  const legacy = await optional(`${profile.userDataPath}/workspace-state.json`);
  const noBootstrap = await optional(profile.environment.OPENWORK_DESKTOP_BOOTSTRAP_PATH) === undefined && await optional(`${root}/bootstrap.json`) === undefined;
  const dataHomes = [profile.environment.XDG_DATA_HOME, `${profile.userDataPath}/openwork-dev-data/xdg/data`];
  const configHomes = [profile.environment.OPENCODE_CONFIG_DIR, `${profile.userDataPath}/openwork-dev-data/config/opencode`];
  const env = await optional(profile.environment.OPENWORK_ENV_STORE);
  let noNativeProviderCredentials = env === undefined || (Array.isArray(env?.variables) && env.variables.length === 0);
  for (const file of [
    ...dataHomes.flatMap((home) => [`${home}/opencode/auth.json`, `${home}/opencode/mcp-auth.json`]),
    ...configHomes.map((home) => `${home}/mcp-auth.json`),
  ]) {
    const auth = await optional(file);
    if (auth !== undefined && (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).length !== 0)) noNativeProviderCredentials = false;
  }
  return {
    expectedWorkspacePath, isolatedProfile: true, noBootstrap, noNativeProviderCredentials,
    nativeWorkspaceValid: validRegistry(registry) && (server === undefined || validRegistry(server)) && (legacy === undefined || validRegistry(legacy)),
  };
}

export async function observeDesktop({ nonce, expectedWorkspacePath }, loadProduct = async () => Promise.all([
  import("/src/app/constants.ts"), import("/src/app/lib/desktop.ts"),
])) {
  const flags = {
    reloaded: nonce === null || globalThis.__openworkPreviewReload === nonce,
    rendererRead: false, productContractRead: false, firstRun: false, noAppCloudIdentity: false,
    signInOffered: false, ordinaryDefaultModel: false, routeReady: false, routeWorkspaceValid: false, noRouteConversations: false,
    nativeRead: false, nativeLocalOnly: false, nativeWorkspaceMatches: false, noNativeCloudSession: false,
    noProvisionedModel: false, noCloudConfiguration: false, noNativeConversations: false,
  };
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const emptyMap = (value) => value === undefined || value === null || (record(value) && Object.keys(value).length === 0);
  const localUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
    } catch { return false; }
  };
  try {
    const prefs = JSON.parse(localStorage.getItem("openwork.preferences") ?? "{}");
    if (!record(prefs)) return flags;
    flags.rendererRead = true;
    flags.firstRun = prefs.hasCompletedOnboarding === undefined || prefs.hasCompletedOnboarding === false;
    flags.noAppCloudIdentity = ["authToken", "activeOrgId", "activeOrgSlug", "activeOrgName", "sessionOrigin", "mcp.sync"]
      .every((key) => !localStorage.getItem(`openwork.den.${key}`));
    flags.signInOffered = [...document.querySelectorAll("button, a, [role=button]")].some((element) => element.textContent?.trim() === "Sign in");
    const route = window.__openwork?.slice("route");
    const workspace = route?.workspaces?.[0];
    flags.routeReady = route?.loading === false && route?.connected === true && route?.connectionPending === false && !route?.routeError;
    flags.routeWorkspaceValid = Array.isArray(route?.workspaces) && route.workspaces.length === 1
      && workspace.workspaceType === "local" && workspace.path === expectedWorkspacePath && workspace.displayNameResolved === "OpenWork Chat"
      && typeof workspace.id === "string" && workspace.id === route.selectedWorkspaceId && !workspace.loading && !workspace.error;
    flags.noRouteConversations = !route?.selectedSessionId && workspace?.sessionCount === 0
      && record(route?.sessionsByWorkspaceId) && Object.values(route.sessionsByWorkspaceId).every((sessions) => Array.isArray(sessions) && sessions.length === 0);
    const [{ DEFAULT_MODEL }, desktop] = await loadProduct();
    flags.productContractRead = record(DEFAULT_MODEL) && typeof DEFAULT_MODEL.providerID === "string" && typeof DEFAULT_MODEL.modelID === "string";
    if (!flags.productContractRead) return flags;
    const modelRef = `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`;
    const ordinaryModel = (model) => model === undefined || model === null || model === "" || model === modelRef
      || (record(model) && model.providerID === DEFAULT_MODEL.providerID && model.modelID === DEFAULT_MODEL.modelID);
    flags.ordinaryDefaultModel = ordinaryModel(localStorage.getItem("openwork.defaultModel")) && ordinaryModel(prefs.defaultModel);
    const info = await desktop.openworkServerInfo();
    const bootstrap = await desktop.getDesktopBootstrapConfig();
    const base = new URL(info.baseUrl);
    flags.nativeLocalOnly = info.running === true && info.remoteAccessEnabled === false && localUrl(info.baseUrl)
      && bootstrap.fromFile === false && !bootstrap.handoff && !bootstrap.prepared && !bootstrap.enterpriseActivation;
    if (!flags.nativeLocalOnly || !info.clientToken || !info.hostToken) return flags;
    async function get(endpoint, host = false) {
      const response = await fetch(new URL(endpoint, base), {
        headers: host ? { "x-openwork-host-token": info.hostToken } : { authorization: `Bearer ${info.clientToken}` },
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("Native read unavailable");
      return response.json();
    }
    const [registry, cloud, providers] = await Promise.all([
      get("/workspaces"), get("/cloud-provider-sync/status"), get("/runtime-config/providers", true),
    ]);
    const nativeWorkspace = registry?.items?.[0];
    flags.nativeWorkspaceMatches = Array.isArray(registry?.items) && registry.items.length === 1
      && nativeWorkspace.workspaceType === "local" && nativeWorkspace.path === expectedWorkspacePath && nativeWorkspace.preset === "starter"
      && nativeWorkspace.name === "OpenWork Chat"
      && nativeWorkspace.id === workspace?.id && localUrl(nativeWorkspace.baseUrl) && localUrl(nativeWorkspace.opencode?.baseUrl)
      && !nativeWorkspace.openworkHostUrl && !nativeWorkspace.openworkToken;
    flags.noNativeCloudSession = cloud?.hasSession === false;
    flags.noProvisionedModel = record(providers?.provider) && emptyMap(providers.provider)
      && Array.isArray(cloud?.providers) && cloud.providers.length === 0 && Array.isArray(cloud?.skippedProviders) && cloud.skippedProviders.length === 0;
    if (!flags.nativeWorkspaceMatches) return flags;
    const prefix = `/workspace/${encodeURIComponent(nativeWorkspace.id)}`;
    const [config, runtime, sessions] = await Promise.all([
      get(`${prefix}/config`), get(`${prefix}/runtime-config`), get(`${prefix}/opencode/session?limit=1`),
    ]);
    flags.noNativeConversations = Array.isArray(sessions) && sessions.length === 0;
    const configs = [config?.opencode, runtime?.runtime, runtime?.effectiveRuntime,
      runtime?.sources?.projectOpencode?.config, runtime?.sources?.globalOpencode?.config];
    flags.noProvisionedModel = flags.noProvisionedModel && configs.every((entry) => record(entry) && emptyMap(entry.provider) && ordinaryModel(entry.model) && ordinaryModel(entry.small_model));
    const imports = config?.openwork?.cloudImports;
    flags.noCloudConfiguration = record(config?.openwork) && configs.every((entry) => record(entry) && !entry.managedPolicy
      && emptyMap(entry.mcp?.["openwork-cloud"]) && !Object.keys(entry.mcp ?? {}).some((key) => /^(openwork-connect-|openwork-direct-|openwork-app-host-connect-)/.test(key)))
      && (imports === undefined || (record(imports) && ["providers", "plugins", "marketplaces", "configItems", "skills"].every((key) => emptyMap(imports[key]))))
      && emptyMap(config.openwork.desktopCloudSync?.entries);
    flags.nativeRead = true;
  } catch {
    return flags;
  }
  return flags;
}

const observationKeys = [
  "reloaded", "rendererRead", "productContractRead", "firstRun", "noAppCloudIdentity", "signInOffered", "ordinaryDefaultModel",
  "routeReady", "routeWorkspaceValid", "noRouteConversations", "nativeRead", "nativeLocalOnly", "nativeWorkspaceMatches",
  "noNativeCloudSession", "noProvisionedModel", "noCloudConfiguration", "noNativeConversations",
];

export async function inspectDesktop({ reload = false, timeoutMs = 60_000, loadCdp = () => import("/workspace/evals/packages/cdp/src/index.ts"), readProfile = readDesktopProfile,
  report = (flags) => console.error("Desktop readiness failed:", JSON.stringify(flags)),
} = {}) {
  const diagnostics = Object.fromEntries(["profileRead", "isolatedProfile", "noBootstrap", "noNativeProviderCredentials", "nativeWorkspaceValid", "cdpRead", "interactive", ...observationKeys].map((key) => [key, false]));
  let surface;
  let init;
  let ready = false;
  diagnostics.cleanupSucceeded = true;
  try {
    const { attachSurface, addInitScript, browserScript, evaluate, probeAppState, isInteractive } = await loadCdp();
    surface = await attachSurface({ name: "preview-desktop-only", kind: "electron", hostKind: "local", cdpUrl: "http://127.0.0.1:9825" }, { timeoutMs: Math.min(timeoutMs, 30_000) });
    const nonce = reload ? randomUUID() : null;
    if (reload) {
      init = await addInitScript(surface.client, browserScript((value) => { globalThis.__openworkPreviewReload = value; }, [nonce]));
      await surface.client.send("Page.reload", { ignoreCache: true }, { timeoutMs: 10_000 });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const profile = await readProfile().catch(() => null);
      diagnostics.profileRead = profile !== null;
      for (const key of ["isolatedProfile", "noBootstrap", "noNativeProviderCredentials", "nativeWorkspaceValid"]) diagnostics[key] = profile?.[key] === true;
      const state = await probeAppState(surface.client, { timeoutMs: 3_000 }).catch(() => null);
      diagnostics.cdpRead = state !== null;
      diagnostics.interactive = Boolean(state && isInteractive(state) && state.surface === "workspace" && state.workspaceId);
      const observed = profile ? await evaluate(surface.client, browserScript(observeDesktop, [{ nonce, expectedWorkspacePath: profile.expectedWorkspacePath }]), { timeoutMs: 20_000, awaitPromise: true }).catch(() => null) : null;
      for (const key of observationKeys) diagnostics[key] = observed?.[key] === true;
      if (Object.values(diagnostics).every((value) => value === true)) {
        ready = true;
        break;
      }
      await delay(250);
    }
  } catch {
    diagnostics.cdpRead = false;
  } finally {
    try { await init?.dispose(); } catch { diagnostics.cleanupSucceeded = false; }
    try { await surface?.stop(); } catch { diagnostics.cleanupSucceeded = false; }
  }
  if (ready && diagnostics.cleanupSucceeded) return {
    ready: true, signedOut: true, firstRun: true, emptyLocalWorkspace: true, noConversations: true, noDemoAccount: true,
    noProvisionedModel: true, ordinaryDefaultModel: true, noNativeCloudSession: true, noNativeProviderCredentials: true, isolatedProfile: true, noBootstrap: true,
  };
  report(diagnostics);
  const error = new Error(`Desktop did not reach pristine signed-out state: ${JSON.stringify(diagnostics)}`);
  error.diagnostics = diagnostics;
  throw error;
}
