import { browserScript, listTargets } from "@openwork/cdp";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app as startApp, server as startServer, resolveEvalEngine } from "@openwork/env";
import { SkipError } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { createAndSelectWorkspace, evalIn, go, waitFor as waitForBehavior } from "@openwork/behaviors";
import { allocateFreePort } from "@openwork/cdp";
import {
  checkedExec,
  chrome,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  enterpriseTlsEdgeDaytonaCommands,
  localHost,
  provisionDesktopSandbox,
} from "@openwork/hosts";
import { startEgressLab, startMockMcp } from "@openwork/labs";
import { diagnoseEgressLabProduct } from "@openwork/behaviors";
import { configureProvider } from "./chat.ts";
import { matchVerdictExpectations } from "@openwork/matchers";
import {
  assignPluginToMarketplace,
  completeDesktopHandoff,
  createDesktopHandoffGrant,
  createMarketplace,
  createPluginWithSkill,
  ensureMemberSession,
  grantMarketplaceAccess,
  readHandoffDeepLink,
  readResolvedMarketplace,
  signIn,
  signInInBrowser,
} from "@openwork/behaviors";

// Transitional helpers for journeys whose product-specific mechanics do not yet
// have spec primitives. Specs still import through their owned world module.
export {
  control,
  enabledButtons,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  visibleText,
  waitFor,
} from "@openwork/behaviors";
export {
  checkedExec,
  chrome,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  enterpriseTlsEdgeDaytonaCommands,
  provisionDesktopSandbox,
} from "@openwork/hosts";

export async function emptyInfraWorld(_seed: Seed) {
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function appSmokeWorld(seed: Seed) {
  const packaged = Boolean(process.env.OPENWORK_EVAL_ELECTRON_BINARY);
  const app = packaged
    ? await desktop({ name: "app-smoke", prepareSharedResources: false, timeoutMs: 60_000,
      env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "" } })
    : await seed.desktop({ name: "app-smoke" });
  const workspace = packaged ? null : await seed.workspace(app, seed.tmpPath("app-smoke"));
  return {
    app, workspace, packaged,
    async packagedRuntime() {
      return evalIn(app, async () => {
        const bridge = window.__OPENWORK_ELECTRON__;
        if (typeof bridge?.invokeDesktop !== "function") return { bridge: false };
        const info = await bridge.invokeDesktop("openworkServerInfo");
        const health = await fetch(info.baseUrl + "/health", { signal: AbortSignal.timeout(5000) });
        return { bridge: true, protocol: location.protocol, health: health.status,
          emptySession: /^#\/workspace\/[^/]+\/session$/.test(location.hash)
            && Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')),
          signedOut: !localStorage.getItem("openwork.den.authToken") && !localStorage.getItem("openwork.den.activeOrgId"),
          onboarding: /Welcome to OpenWork|Power your first task|How did you hear about OpenWork\?/.test(document.body.innerText),
          crash: /Something went wrong|Cannot find module|Maximum update depth exceeded/.test(document.body.innerText) };
      }, { awaitPromise: true });
    },
    async packagedToolIds() {
      return evalIn(app, async () => {
        const workspaces = await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap");
        const workspace = workspaces.workspaces.find((entry) => entry.id === workspaces.selectedId);
        if (workspaces.workspaces.length !== 1 || !workspace?.path?.endsWith("OpenWork Chat")) {
          throw new Error("Packaged startup did not select its default chat workspace.");
        }
        const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
        const headers = { Authorization: "Bearer " + info.ownerToken, "Content-Type": "application/json" };
        const tools = await fetch(info.baseUrl + "/workspace/" + workspace.id + "/opencode/experimental/tool/ids", {
          headers, signal: AbortSignal.timeout(30000),
        });
        if (!tools.ok) throw new Error("Engine tool discovery failed: " + tools.status);
        return tools.json();
      }, { awaitPromise: true, timeoutMs: 60_000 });
    },
    async [Symbol.asyncDispose]() { await app[Symbol.asyncDispose](); },
  };
}

export async function bareFirstRunWorld(seed: Seed, { place }: { place: Place }) {
  const app = await seed.desktop({ name: "first-run", signIn: false });
  const url = new URL(await evalIn(app, () => location.href));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The non-desktop welcome journey requires the source app's HTTP surface.");
  }
  url.hash = "/welcome";
  const web = await chrome({ name: "first-run-welcome", host: place.host(), startUrl: url.href, headless: true });
  return {
    app,
    web,
    async openedUrls() { return (await listTargets(web.handle.cdpUrl)).map((target) => target.url); },
    async [Symbol.asyncDispose]() { await web[Symbol.asyncDispose](); },
  };
}

export async function localFirstRunWorld(seed: Seed) {
  const prompt = "Create a short welcome checklist for this OpenWork workspace. Use exactly three bullets and mention one thing I can do next.";
  const reply = "Your workspace is ready. You can draft a document next.";
  const den = await seed.den({
    provision: false,
    mocks: { starter: seed.mock({ agentWorkloads: [{ promptMarker: prompt, finalReply: reply, steps: [] }] }) },
  });
  const mock = den.mocks.starter;
  // Only replace the provider transport. Do not seed a workspace, session,
  // sign-in, onboarding preference, or selected model: the app must supply them.
  const app = await seed.desktop({
    name: "first-run-local",
    signIn: false,
    env: {
      DAYTONA_SECRETS_ENV: "/tmp/openwork-first-run-no-secrets",
      OPENWORK_DESKTOP_DISTRIBUTION: "public",
      OPENWORK_EVAL_MODEL: "",
      VITE_DISABLE_OPENWORK_MODELS: "0",
      OPENCODE_CONFIG: "",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ["opencode"],
        small_model: "opencode/big-pickle",
        provider: {
          opencode: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${mock.url}/v1`, apiKey: "sk-eval-fixture" },
            whitelist: ["big-pickle"],
            models: {
              "big-pickle": {
                name: "Big Pickle",
                provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
              },
            },
          },
        },
      }),
    },
  });
  return { app, mock, prompt, reply };
}

export async function workspaceWorld(seed: Seed) {
  const app = await seed.desktop({ name: "workspace-spec" });
  const workspacePath = seed.tmpPath("workspace-spec");
  const workspace = await seed.workspace(app, workspacePath);
  return { app, workspace, workspacePath };
}

export async function sessionWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const session = await seed.session(base.app);
  return { ...base, session };
}

/**
 * A workspace with a mock model and NO session: the person lands on the
 * sessionless New task route and the first Run task must create the session
 * and deliver the prompt through whichever engine (v1 or v2) is selected.
 */
export async function sessionlessFirstSendWorld(seed: Seed) {
  const engine = resolveEvalEngine();
  const providerId = "first-send-mock";
  const modelId = "first-send-model";
  const nonce = `${Date.now().toString(36)}-${process.pid}`;
  const prompt = `Summarize this workspace in one sentence. FIRST-SEND-${nonce}`;
  const reply = `Workspace summary finished ${nonce}.`;
  await using setup = new AsyncDisposableStack();
  const mock = setup.use(await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [{ promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] }],
  }));
  const { app, workspace, workspacePath } = await workspaceWorld(seed);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "First send mock",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-first-send" },
        models: { [modelId]: { name: "First send model" } },
      },
    },
  });
  const resources = setup.move();
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}`;
  return {
    app,
    workspace,
    workspacePath,
    engine,
    prompt,
    reply,
    sessionlessRoute: `#/workspace/${workspace.workspaceId}/session`,
    /** Engine-native message list for one session, on the selected engine's mount. */
    messagesPath: (sessionId: string) => engine === "v2"
      ? `${mount}/opencode2/api/session/${encodeURIComponent(sessionId)}/message`
      : `${mount}/opencode/session/${encodeURIComponent(sessionId)}/message`,
    /** Engine-native session list on the selected engine's mount. */
    sessionsPath: engine === "v2" ? `${mount}/opencode2/api/session` : `${mount}/opencode/session?limit=100`,
    openNewTask: () => go(app, `/workspace/${workspace.workspaceId}/session`),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

export async function parentChildPermissionWorld(seed: Seed) {
  const base = await sessionWorld(seed);
  // TODO(primitive): seed a child-session permission request and parent activity row.
  const seeded = await seed.evalIn(base.app, async () => {
    const child = await window.__openworkControl.execute("eval.child_permission.seed", null);
    if (!child?.ok || !child.result || typeof child.result !== "object" || !("childSessionId" in child.result) || typeof child.result.childSessionId !== "string") return { child, activity: null };
    const activity = await window.__openworkControl.execute("eval.task_activity.seed", {
      childSessionId: child.result.childSessionId,
    });
    return { child, activity };
  }, { awaitPromise: true });
  if (!isRecord(seeded) || !isRecord(seeded.child) || seeded.child.ok !== true
    || !isRecord(seeded.activity) || seeded.activity.ok !== true) {
    throw new Error(`Child permission seed failed: ${JSON.stringify(seeded)}`);
  }
  return base;
}

export async function scopedPermissionRefreshWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const sessions = await seed.sessions(base.app, Array.from({ length: 8 }, (_, index) => `Permission scope ${index}`));
  const [unrelated, selected] = sessions;
  if (!unrelated || !selected) throw new Error("Permission scope sessions were not created");
  const engine = resolveEvalEngine();
  const prefix = `/workspace/${encodeURIComponent(base.workspace.workspaceId)}/${engine === "v2" ? "opencode2" : "opencode"}`;
  const debuggerUrl = base.app.client.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("Permission witness needs a desktop CDP endpoint");
  const socket = new WebSocket(debuggerUrl);
  const ready = Promise.withResolvers<void>();
  const commands = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const reads: { sessionId: string; networkId: string; calibration: boolean; held: boolean }[] = [];
  const finished = new Set<string>();
  let nextId = 1;
  let failure: Error | undefined;
  const command = async (method: string, params = {}) => {
    const id = nextId++;
    const result = Promise.withResolvers<void>();
    commands.set(id, result);
    const timeout = setTimeout(() => result.reject(new Error(`Permission witness timed out: ${method}`)), 15_000);
    try {
      socket.send(JSON.stringify({ id, method, params }));
      await result.promise;
    } finally {
      clearTimeout(timeout);
      commands.delete(id);
    }
  };
  const readyTimeout = setTimeout(() => ready.reject(new Error("Permission witness did not connect")), 15_000);
  socket.addEventListener("open", () => ready.resolve());
  socket.addEventListener("error", () => {
    failure = new Error("Permission witness connection failed");
    ready.reject(failure);
  });
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = commands.get(message.id);
      if (message.error) pending?.reject(new Error("Permission witness command failed"));
      else pending?.resolve();
    }
    const params = message.params;
    if (!isRecord(params)) return;
    if (message.method === "Network.loadingFinished" && typeof params.requestId === "string") finished.add(params.requestId);
    if (message.method !== "Fetch.requestPaused" || typeof params.requestId !== "string") return;
    const request = params.request;
    if (!isRecord(request) || typeof request.url !== "string") return;
    const url = new URL(request.url);
    const match = url.pathname.slice(prefix.length).match(/^\/api\/session\/([^/]+)\/permission$/);
    const sessionId = match?.[1] ? decodeURIComponent(match[1]) : "";
    if (request.method === "GET" && sessionId && typeof params.networkId === "string") {
      // Hold every read of one unrelated root, not just a single lucky request.
      // The calibration proves the fault is active without relying on timing.
      const held = sessionId === unrelated.sessionId;
      reads.push({ sessionId, networkId: params.networkId, calibration: url.searchParams.has("scope-calibration"), held });
      if (held) return;
    }
    void command("Fetch.continueRequest", { requestId: params.requestId }).catch((error: Error) => { failure = error; });
  });
  const dispose = async () => {
    clearTimeout(readyTimeout);
    try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
    finally { socket.close(); }
  };
  try {
    await ready.promise;
    clearTimeout(readyTimeout);
    await command("Network.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: `*${prefix}/api/session/*/permission*`, requestStage: "Request" }] });
    await seed.evalIn(base.app, browserScript(async (path) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      void fetch(info.baseUrl + path, {
        headers: { Authorization: `Bearer ${info.ownerToken}` }, signal: AbortSignal.timeout(120_000),
      }).catch(() => undefined);
    }, [`${prefix}/api/session/${encodeURIComponent(unrelated.sessionId)}/permission?scope-calibration=1`]), { awaitPromise: true });
    return {
      ...base, selected, unrelated, engine,
      permissionReads() {
        if (failure) throw failure;
        return reads.map((read) => ({ sessionId: read.sessionId, calibration: read.calibration, held: read.held, completed: finished.has(read.networkId) }));
      },
      async [Symbol.asyncDispose]() { await dispose(); },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function artifactCodeBrowserWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const [session] = await seed.sessions(base.app, ["Artifact code browser proof"]);
  if (!session) throw new Error("Could not seed the artifact code browser session.");
  await go(base.app, `/workspace/${base.workspace.workspaceId}/session/${session.sessionId}`);
  // TODO(primitive): write workspace files through the local server fixture.
  const wrote = await seed.evalIn(base.app, browserScript(async (workspaceId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return false;
    const write = (path: string, content: string) => fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ path, content, baseUpdatedAt: null }),
      },
    );
    const responses = await Promise.all([
      write("restricted/hidden-proof.ts", "export const restricted = true;"),
      write("src/openwork-artifact-proof.ts", "export const artifactEditor = true;\n"),
      write("config/openwork-artifact-settings.json", "{\"artifactEditor\":true}\n"),
    ]);
    return responses.every((response) => response.ok);
  }, [base.workspace.workspaceId]), { awaitPromise: true });
  if (wrote !== true) throw new Error("Could not seed artifact code files.");
  // TODO(primitive): open an initial built-in browser artifact tab.
  await seed.evalIn(base.app, () => (window.__openworkControl.execute("browser.open_url", { url: "about:blank" })), { awaitPromise: true });
  await waitForBehavior(
    base.app,
    () => (window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)),
    { timeoutMs: 30_000, label: "artifact seed action enabled" },
  );
  // TODO(primitive): seed artifact tabs through a first-class artifact fixture.
  const tabs = await seed.evalIn(base.app, () => (window.__openworkControl.execute("eval.artifact_tabs.seed_overflow", { count: 12 })), { awaitPromise: true });
  if (!isRecord(tabs) || tabs.ok !== true) throw new Error(`Could not seed artifact tabs: ${JSON.stringify(tabs)}`);
  return {
    ...base,
    async visibleArtifactCode() {
      return seed.evalIn(base.app, () => {
        const root = document.querySelector<HTMLElement>("[data-artifact-code-view]");
        if (!root || root.getBoundingClientRect().height === 0) return "";
        const text = (node: Node): string => [...node.childNodes].map((child) =>
          child.nodeType === Node.TEXT_NODE ? child.textContent :
          child instanceof Element ? text(child.shadowRoot || child) : ""
        ).join("");
        return text(root);
      });
    },
    async setCatalogFolderRestricted(restricted: boolean) {
      const path = join(base.workspacePath, "restricted");
      const mode = restricted ? "000" : "700";
      const sandbox = base.app.handle.sandboxId;
      if (sandbox) {
        await checkedExec(defaultDaytonaExec, remoteCommand(sandbox, `chmod ${mode} ${shellQuote(path)}`), "set synthetic catalog folder permissions");
      } else {
        await chmod(path, restricted ? 0 : 0o700);
      }
    },
  };
}

export async function skillsLocalWorld(seed: Seed) {
  const app = await seed.desktop({ name: "skills-local" });
  if (!app.workspaceRoot) throw new Error("The skills desktop did not expose its checkout root.");
  const workspace = await seed.workspace(app, app.workspaceRoot);
  return { app, workspace };
}

export async function firstRunBootstrapWorld(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "First Run Bootstrap",
      admin: { name: "First Run Bootstrap Admin" },
      members: { member: { name: "First Run Bootstrap Member" } },
    },
  });
  const proxy = await seed.faultProxy(den);
  proxy.faults.status("/api/den/v1/me/desktop-config", 429, { times: 5 });
  const proxiedDen = { ...den, ref: proxy.ref };
  const grant = await createDesktopHandoffGrant(den.members.member);
  const app = await seed.desktop({ den: proxiedDen, signIn: false });
  return { app, den, proxy, grant };
}

export async function firstSignInWorld(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "First Signin Heal",
      admin: { name: "First Signin Admin" },
      members: { fresh: { name: "Fresh Profile Member" } },
    },
  });
  const proxy = await seed.faultProxy(den);
  proxy.faults.status("/api/den/v1/me/orgs", 429, { times: 3 });
  const proxiedDen = { ...den, ref: proxy.ref };
  const grant = await createDesktopHandoffGrant(den.members.fresh);
  const app = await seed.desktop({ den: proxiedDen, signIn: false });
  return { app, den, proxy, grant };
}

export async function testkitAppBootWorld(_seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  const den = stack.use(await startServer({ place }));
  if (!den.ports) throw new Error("The local testkit Den did not expose its ports.");
  const app = stack.use(await startApp({ den, as: "admin", place }));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await stack.disposeAsync();
  };
  return { app, den, ports: den.ports, close, [Symbol.asyncDispose]: close };
}

export async function unconfiguredNotificationWorld(seed: Seed) {
  const workspacePath = await mkdtemp(join(tmpdir(), "openwork-notification-shell-"));
  const app = await seed.desktop({ name: "opencode-unconfigured-notification" });
  const workspace = await seed.workspace(app, workspacePath);
  const serverToken = "owt_unconfigured_notification";
  const repoRoot = resolve(import.meta.dirname, "../..");
  const script = `
    const { startServer } = await import("./src/server.ts");
    const server = await startServer({
      host: "0.0.0.0", port: 0, token: ${JSON.stringify(serverToken)}, corsOrigins: ["*"],
      workspaces: [{ id: ${JSON.stringify(workspace.workspaceId)}, name: "Unconfigured workspace", path: ${JSON.stringify(workspacePath)}, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [${JSON.stringify(workspacePath)}], readOnly: false,
      approval: { mode: "auto", timeoutMs: 30000 }, startedAt: Date.now(), tokenSource: "cli",
      hostTokenSource: "none", logFormat: "pretty", logRequests: false,
    });
    console.log("UNCONFIGURED_SERVER_PORT:" + server.port);
    setInterval(() => {}, 60000);
  `;
  const child = spawn("bun", ["--conditions=development", "-e", script], {
    cwd: join(repoRoot, "apps", "server"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("Unconfigured server did not report a port.")), 30_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/UNCONFIGURED_SERVER_PORT:(\d+)/);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Unconfigured server exited early (${code}): ${stderr.slice(0, 500)}`));
    });
    child.on("error", reject);
  });
  const configResponse = await fetch(`http://127.0.0.1:${port}/workspace/${workspace.workspaceId}/config`, {
    headers: { authorization: `Bearer ${serverToken}` },
  });
  const config: unknown = await configResponse.json();
  const opencodeConfig = isRecord(config) && isRecord(config.opencode) ? config.opencode : {};
  const providerConfig = isRecord(opencodeConfig.provider) ? opencodeConfig.provider : {};
  const engineResponse = await fetch(`http://127.0.0.1:${port}/workspace/${workspace.workspaceId}/opencode/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${serverToken}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const engineError: unknown = await engineResponse.json();
  // TODO(primitive): point a desktop at a caller-owned local server and observe transient notification text.
  const switched = await evalIn(app, browserScript(async (port, serverToken) => {
    const state = { rawSeen: document.body.innerText.includes('{"code":') };
    const observer = new MutationObserver(() => {
      if (document.body.innerText.includes('{"code":')) state.rawSeen = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__issue3980NotificationProbe = { observer, state };
    localStorage.setItem("openwork.server.urlOverride", `http://127.0.0.1.nip.io:${port}`);
    localStorage.setItem("openwork.server.token", serverToken);
    localStorage.removeItem("openwork.server.hostToken");
    await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("engineStop");
    window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    return true;
  }, [port, serverToken]), { awaitPromise: true, timeoutMs: 30_000 });
  if (switched !== true) throw new Error("Could not switch the desktop to the unconfigured server.");
  return {
    app,
    workspace,
    serverToken,
    directBaseUrl: `http://127.0.0.1:${port}`,
    configStatus: configResponse.status,
    opencodeConfig,
    providerConfig,
    engineStatus: engineResponse.status,
    engineError,
    async [Symbol.asyncDispose]() {
      child.kill("SIGKILL");
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

async function installAlphaUpdateBridge(app: Awaited<ReturnType<typeof desktop>>) {
  const installed = await evalIn(app, () => {
    const nativeUpdater = window.__OPENWORK_ELECTRON__?.updater;
    if (!nativeUpdater?.getChannel || !nativeUpdater.setChannel) return false;
    const state: Window["__openworkAlphaUpdateEligibilityEvalState"] = { checks: [], currentVersion: "0.18.37-alpha.2491+64d2d37", latestVersion: "0.18.37-alpha.2492+4921a02" };
    window.__openworkAlphaUpdateEligibilityEvalState = state;
    localStorage.setItem("openwork.react.settings.update-auto-check", "0");
    window.__openworkApplyDesktopConfig?.({ allowAlphaUpdates: true });
    window.__openworkSetDesktopConfigRefreshResult?.({ allowAlphaUpdates: true });
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.17.0", latestAppVersion: "0.18.35", publishedDesktopVersions: ["0.18.35"],
    });
    window.__openworkUpdaterEvalBridge = {
      getChannel: () => nativeUpdater.getChannel(),
      setChannel: (channel) => nativeUpdater.setChannel(channel),
      check: async (channel) => {
        state.checks.push(channel);
        return channel === "alpha"
          ? { available: true, channel, currentVersion: state.currentVersion, latestVersion: state.latestVersion }
          : { available: false, channel, currentVersion: state.currentVersion, latestVersion: "0.18.35" };
      },
      download: async () => ({ ok: false, reason: "unused" }),
      installAndRestart: async () => ({ ok: false, reason: "unused" }),
      onDownloadProgress: () => () => {},
    };
    return true;
  });
  if (installed !== true) throw new Error("Could not install the controlled updater bridge.");
}

export async function alphaUpdateWorld(seed: Seed) {
  if (process.platform !== "darwin") throw new SkipError(`run on macOS (Alpha is unavailable on ${process.platform})`);
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-alpha-update-eligibility-eval-"));
  const host = localHost();
  const app = await desktop({
    name: "alpha-update-eligibility",
    host,
    profileDir,
    env: { PORT: String(await allocateFreePort()) },
  });
  const workspace = await createAndSelectWorkspace(app, { path: join(profileDir, "workspace") });
  await installAlphaUpdateBridge(app);
  await go(app, `/workspace/${workspace.workspaceId}/settings/updates`);
  return {
    app,
    async [Symbol.asyncDispose]() {
      await app.stop();
      await host[Symbol.asyncDispose]();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

export async function compatibleReleaseWorld(_seed: Seed, { place }: { place: Place }) {
  const app = await desktop({
    name: "compatible-release-picker",
    host: place.host(),
    timeoutMs: 30_000,
    env: {
      OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: "EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE",
      OPENWORK_EVAL_RECOVERY_TARGET: "darwin-arm64-public",
      OPENWORK_EVAL_RECOVERY_RELEASES: JSON.stringify([
        { version: "2.4.0", channel: "stable", artifact: { platform: "darwin", arch: "arm64", distribution: "public", url: "https://releases.openwork.test/v2.4.0/OpenWork-darwin-arm64.dmg" } },
        { version: "2.3.1", channel: "stable", artifact: { platform: "darwin", arch: "arm64", distribution: "public", url: "https://releases.openwork.test/v2.3.1/OpenWork-darwin-arm64.dmg" } },
        { version: "2.3.0", channel: "stable", artifact: { platform: "linux", arch: "x64", distribution: "public", url: "https://incompatible.invalid/OpenWork.AppImage" } },
        { version: "2.2.9", channel: "stable", artifact: { platform: "darwin", arch: "arm64", distribution: "enterprise", url: "https://wrong-flavor.invalid/OpenWork.dmg" } },
        { version: "2.2.8-beta.1", channel: "prerelease", artifact: { platform: "darwin", arch: "arm64", distribution: "public", url: "https://prerelease.invalid/OpenWork.dmg" } },
      ]),
    },
  });
  const snapshot = () => evalIn(app, () => (window.__openworkRecoveryControl.snapshot()), { awaitPromise: true });
  return { app, snapshot, async [Symbol.asyncDispose]() { await app.stop(); } };
}

export async function reliableRecoveryWorld(_seed: Seed, { place }: { place: Place }) {
  const profileDir = `/tmp/openwork-reliable-recovery-${process.pid}-${Date.now()}`;
  const provisioned = place.kind === "daytona"
    ? await provisionDesktopSandbox({
        ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
        name: "reliable-app-recovery",
        reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
        log: (line) => console.error(`[openwork/testkit] ${line}`),
      })
    : null;
  const host = provisioned ? daytonaSandbox(provisioned.sandbox) : localHost();
  const seeded = await desktop({ name: "recovery-profile-seed", host, profileDir });
  const names = await evalIn(seeded, browserScript((value) => (window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
    folderPath: value, name: "reliable-recovery-profile-marker"
  }).then((state) => state.workspaces.map((workspace) => workspace.displayName))), [`${profileDir}/continuity-workspace`]), { awaitPromise: true });
  if (!Array.isArray(names) || !names.includes("reliable-recovery-profile-marker")) throw new Error("Could not seed recovery profile.");
  await seeded.stop();
  const app = await desktop({
    name: "fatal-bootstrap-recovery",
    host,
    profileDir,
    timeoutMs: 30_000,
    env: {
      OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: "EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: dlopen(/private/tmp/runtime.node): invalid code signature",
      OPENWORK_EVAL_RECOVERY_CANDIDATES: JSON.stringify([
        { version: "1.8.2", verified: true, artifactUrl: "https://releases.openwork.test/v1.8.2/OpenWork-darwin-arm64.dmg" },
        { version: "1.8.1", verified: false, artifactUrl: "https://tampered.invalid/OpenWork.dmg" },
      ]),
    },
  });
  const snapshot = () => evalIn(app, () => (window.__openworkRecoveryControl.snapshot()), { awaitPromise: true });
  const workspaceNames = () => evalIn(
    app,
    () => (window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap").then((state) => state.workspaces.map((entry) => entry.displayName))),
    { awaitPromise: true },
  );
  return {
    app,
    snapshot,
    workspaceNames,
    async [Symbol.asyncDispose]() {
      await app.stop();
      if (provisioned) {
        await checkedExec(
          defaultDaytonaExec,
          ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
          `remove caller-owned recovery profile ${profileDir}`,
          { timeoutMs: 30_000 },
        );
      } else {
        await rm(profileDir, { recursive: true, force: true });
      }
      await host[Symbol.asyncDispose]();
      if (provisioned?.created) await deleteSandboxes([provisioned.sandbox]);
    },
  };
}

/**
 * A healthy desktop whose render tree is about to throw. The spec triggers the
 * throw through the dev-only `eval.app.render_throw` control action and reads
 * back what the recovery screen put on the clipboard.
 */
export async function renderCrashWorld(seed: Seed) {
  const app = await seed.desktop({ name: "render-crash" });
  return {
    app,
    readClipboard: () => seed.evalIn(app, () => (navigator.clipboard.readText()), { awaitPromise: true }),
  };
}

async function installUpdaterRaceBridge(app: Awaited<ReturnType<typeof desktop>>, delayStable: boolean) {
  const installed = await evalIn(app, browserScript((delayStable) => {
    const nativeUpdater = window.__OPENWORK_ELECTRON__?.updater;
    if (!nativeUpdater?.getChannel || !nativeUpdater.setChannel) return false;
    const state: Window["__openworkUpdaterEvalState"] = { checks: [], setChannels: [], stableStarted: false, finishStable: null };
    window.__openworkUpdaterEvalState = state;
    window.__openworkApplyDesktopConfig?.({ allowAlphaUpdates: true });
    window.__openworkSetDesktopConfigRefreshResult?.({ allowAlphaUpdates: true });
    window.__openworkUpdaterEvalBridge = {
      getChannel: () => nativeUpdater.getChannel(),
      setChannel: async (channel) => { state.setChannels.push(channel); return nativeUpdater.setChannel(channel); },
      check: async (channel) => {
        state.checks.push(channel);
        if (delayStable && channel === "stable") {
          state.stableStarted = true;
          return new Promise((resolve) => { state.finishStable = () => resolve({ available: true, channel: "stable", currentVersion: "0.18.0", latestVersion: "9.9.9" }); });
        }
        return { available: false, channel, currentVersion: "0.18.0", latestVersion: channel === "alpha" ? "0.18.0-alpha.1" : "0.18.0" };
      },
      download: async () => ({ ok: false, reason: "unused" }),
      installAndRestart: async () => ({ ok: false, reason: "unused" }),
      onDownloadProgress: () => () => {},
    };
    return true;
  }, [delayStable]));
  if (installed !== true) throw new Error("Could not install updater race bridge.");
}

export async function updaterChannelWorld(_seed: Seed) {
  if (process.platform !== "darwin") throw new SkipError(`run on macOS (Alpha is unavailable on ${process.platform})`);
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-updater-channel-eval-"));
  const host = localHost();
  const env = { PORT: String(await allocateFreePort()) };
  const app = await desktop({ name: "updater-channel-selection", host, profileDir, env });
  const workspace = await createAndSelectWorkspace(app, { path: join(profileDir, "workspace") });
  await installUpdaterRaceBridge(app, true);
  await go(app, `/workspace/${workspace.workspaceId}/settings/updates`);
  let active = app;
  const relaunch = async () => {
    await active.client.send("Browser.close").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CDP websocket (?:failed|closed)/i.test(message)) throw error;
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const stopped = await fetch(`${active.handle.cdpUrl.replace(/\/$/, "")}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      }).then(() => false, () => true);
      if (stopped) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    await active.stop();
    active = await desktop({ name: "updater-channel-selection", host, profileDir, env });
    await go(active, "/session");
    await installUpdaterRaceBridge(active, false);
    await go(active, `/workspace/${workspace.workspaceId}/settings/updates`);
    await waitForBehavior(active, () => (window.location.hash.includes("/settings/updates") && Boolean(document.querySelector<HTMLElement>('[aria-label="Release channel"]'))), {
      timeoutMs: 60_000,
      label: "relaunched Updates page",
    });
    return active;
  };
  return {
    app,
    relaunch,
    async [Symbol.asyncDispose]() {
      await active.stop();
      await host[Symbol.asyncDispose]();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function remoteCommand(sandbox: string, command: string): string[] {
  return ["exec", sandbox, "--", `bash -lc ${shellQuote(command)}`];
}

async function cleanup(label: string, action: () => PromiseLike<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[openwork/testkit] ${label} cleanup failed: ${message}`);
  }
}

export async function enterpriseTlsWorld(seed: Seed, { place }: { place: Place }) {
  const den = await seed.den();
  const provisioned = await provisionDesktopSandbox({
    ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
    name: "den-behind-enterprise-tls",
    reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
    log: (line) => console.error(`[openwork/testkit] ${line}`),
  });
  const profileDir = `/workspace/.openwork-daytona/profiles/enterprise-tls-${process.pid}-${Date.now()}`;
  const edge = enterpriseTlsEdgeDaytonaCommands({ sandboxId: provisioned.sandbox, upstream: den.ref.webUrl });
  let edgeStarted = false;
  let rootInstallAttempted = false;
  let rawApp: Awaited<ReturnType<typeof desktop>> | null = null;
  let trustedApp: Awaited<ReturnType<typeof startApp>> | null = null;
  const host = daytonaSandbox(provisioned.sandbox);

  const dispose = async () => {
    if (trustedApp) await cleanup("dispose trusted enterprise TLS app", () => trustedApp?.[Symbol.asyncDispose]() ?? Promise.resolve());
    if (rawApp) await cleanup("dispose pre-trust enterprise TLS app", () => rawApp?.stop() ?? Promise.resolve());
    await cleanup("remove caller-owned enterprise TLS profile", () => checkedExec(
      defaultDaytonaExec,
      ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
      `remove caller-owned profile ${profileDir}`,
      { timeoutMs: 30_000 },
    ));
    if (rootInstallAttempted) {
      await cleanup("remove enterprise TLS root", () => checkedExec(defaultDaytonaExec, edge.removeRoot, "remove enterprise TLS root", { timeoutMs: 120_000 }));
    }
    if (edgeStarted) {
      await cleanup("stop enterprise TLS edge", () => checkedExec(defaultDaytonaExec, edge.stop, "stop enterprise TLS edge", { timeoutMs: 30_000 }));
    }
    await cleanup("dispose Daytona desktop host", () => host[Symbol.asyncDispose]());
    if (provisioned.created) await cleanup("delete Daytona desktop sandbox", () => deleteSandboxes([provisioned.sandbox]));
  };

  try {
    for (const [index, command] of edge.prepare.entries()) {
      await checkedExec(defaultDaytonaExec, command, `prepare enterprise TLS edge chunk ${index + 1}/${edge.prepare.length}`, { timeoutMs: 30_000 });
    }
    await checkedExec(defaultDaytonaExec, edge.start, "start enterprise TLS edge", { timeoutMs: 120_000 });
    edgeStarted = true;
    await checkedExec(defaultDaytonaExec, edge.probe, "probe enterprise TLS edge", { timeoutMs: 30_000 });
    rawApp = await desktop({
      name: "enterprise-tls-before-os-trust",
      host,
      profileDir,
      bootstrap: { baseUrl: edge.candidateUrl, requireSignin: false },
    });
    // TODO(primitive): seed a named workspace in a caller-owned desktop profile.
    const seededWorkspaceNames = await seed.evalIn(
      rawApp,
      browserScript((folderPath) => window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
        folderPath,
        name: "enterprise-tls-profile-continuity"
      }).then((state) => state.workspaces.map((workspace) => workspace.displayName)), [`${profileDir}/continuity-workspace`]),
      { awaitPromise: true },
    );
    if (!Array.isArray(seededWorkspaceNames) || !seededWorkspaceNames.includes("enterprise-tls-profile-continuity")) {
      throw new Error("Could not seed the enterprise TLS continuity workspace.");
    }
    await waitForBehavior(
      rawApp,
      () => (window.__openworkControl?.listActions?.().some((action) => action.id === "auth.exchange-grant")),
      { timeoutMs: 60_000, label: "pre-trust sign-in reachability action" },
    );
    const grant = await createDesktopHandoffGrant(den.admin);
    const app = rawApp;
    return {
      app,
      den,
      edge,
      grant,
      profileDir,
      async installTrust() {
        await app.stop();
        rawApp = null;
        rootInstallAttempted = true;
        await checkedExec(
          defaultDaytonaExec,
          edge.installRoot,
          "ENTERPRISE_TLS_ROOT_INSTALL_REQUIRED (root and update-ca-certificates)",
          { timeoutMs: 120_000 },
        );
        const candidateDen = { ...den, ref: { webUrl: edge.candidateUrl, apiUrl: `${edge.candidateUrl}/api/den` } };
        trustedApp = await startApp({ den: candidateDen, as: "admin", place, host, profileDir });
        return trustedApp;
      },
      inspectBundle() {
        const bundlePath = `${profileDir}/electron-userdata/system-ca-bundle.pem`;
        return checkedExec(
          defaultDaytonaExec,
          remoteCommand(provisioned.sandbox, [
            "set -euo pipefail",
            `test -s ${shellQuote(bundlePath)}`,
            `/usr/bin/openssl crl2pkcs7 -nocrl -certfile ${shellQuote(bundlePath)} | /usr/bin/openssl pkcs7 -print_certs -noout`,
          ].join("; ")),
          "inspect product-generated profile system CA bundle",
          { timeoutMs: 30_000 },
        );
      },
      probeSelectiveTrust(encodedProbe: string) {
        const bundlePath = `${profileDir}/electron-userdata/system-ca-bundle.pem`;
        return checkedExec(
          defaultDaytonaExec,
          remoteCommand(
            provisioned.sandbox,
            `export NODE_EXTRA_CA_CERTS=${shellQuote(bundlePath)}; /usr/bin/env node --input-type=module -e "\$(printf %s ${shellQuote(encodedProbe)} | base64 -d)" ${shellQuote(edge.candidateUrl)} ${shellQuote(edge.negativeUrl)}`,
          ),
          "probe selective trust with product-generated CA bundle",
          { timeoutMs: 30_000 },
        );
      },
      readEdgeRequests() {
        return checkedExec(defaultDaytonaExec, edge.requests, "read enterprise TLS edge requests", { timeoutMs: 30_000 });
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function appDenTlsFaultWorld(_seed: Seed, { place }: { place: Place }) {
  const edge = await startEgressLab({ profile: "intercept" });
  const app = await desktop({
    name: "den-tls-fault",
    host: place.host(),
    bootstrap: { baseUrl: edge.url, requireSignin: false },
  });
  const diagnose = async () => {
    const verdict = await diagnoseEgressLabProduct(edge);
    return { ...verdict, expectationMatched: matchVerdictExpectations(verdict.text, "intercept").ok };
  };
  return {
    app,
    diagnose,
    async [Symbol.asyncDispose]() {
      await app.stop();
      await edge[Symbol.asyncDispose]();
    },
  };
}

export async function firstRunCloudShareWorld(seed: Seed, { place }: { place: Place }) {
  const den = await seed.den({
    org: {
      name: "Acme",
      admin: { email: `first-run-cloud-admin-${Date.now()}@openwork.test`, name: "Alex" },
      members: { colleague: { email: `first-run-cloud-colleague-${Date.now()}@openwork.test`, name: "Jordan" } },
    },
  });
  const app = await desktop({
    name: "first-run-cloud-share",
    host: place.host(),
    bootstrap: { baseUrl: den.ref.webUrl, requireSignin: false },
  });
  const web = await seed.web({
    den,
    startPath: "/",
    headless: true,
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  });
  const shareSkill = async () => {
    const stamp = Date.now();
    const skillName = `shared-standup-${stamp}`;
    const marketplace = await createMarketplace(den.admin, { name: `Team Marketplace ${stamp}` });
    const plugin = await createPluginWithSkill(den.admin, {
      name: `Standup Kit ${stamp}`,
      skillName,
      skillBody: "Summarise yesterday, today, and blockers in three short bullets.",
      marketplaceId: marketplace.id,
    });
    await assignPluginToMarketplace(den.admin, marketplace.id, plugin.id).catch(async (error: unknown) => {
      const resolved = await readResolvedMarketplace(den.admin, marketplace.id);
      if (!resolved.pluginNames.includes(plugin.name)) throw error;
    });
    await grantMarketplaceAccess(den.admin, marketplace.id, { orgWide: true });
    const visible = await readResolvedMarketplace(den.members.colleague, marketplace.id);
    return { plugin, skillName, visible };
  };
  return {
    app,
    web,
    den,
    shareSkill,
    async [Symbol.asyncDispose]() { await app.stop(); },
  };
}

function toolResultJson(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  const text = content.map((entry) => typeof entry.text === "string" ? entry.text : "").join("\n");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

export async function toolTesterWorld(seed: Seed) {
  const connectorBoot = seed.mock();
  const den = await seed.den({
    org: { name: `Tool Tester Eval ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: { connector: connectorBoot },
  });
  const connector = den.mocks.connector;
  const connection = await seed.orgConnection(den.admin, {
    name: `Tool Tester Probe ${Date.now()}`,
    url: connector.mcpUrl,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const orgs = await seed.api(den.admin, "/v1/me/orgs");
  const organizations = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
  if (!orgId) throw new Error("Could not resolve the Tool Tester organization.");
  const tokenResult = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": orgId },
    body: JSON.stringify({}),
  });
  const mcpToken = isRecord(tokenResult.body) && typeof tokenResult.body.token === "string" ? tokenResult.body.token : "";
  if (!mcpToken.startsWith("ow_mcp_at_")) throw new Error("Could not mint the Tool Tester MCP token.");
  const web = await seed.web({
    den,
    signedInAs: "admin",
    startPath: "/dashboard/mcp-connections",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  let requestId = 0;
  const callTool = async (name: "search_capabilities" | "execute_capability", args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!data) throw new Error(`MCP tools/call returned no data frame: ${raw.slice(0, 500)}`);
    const frame: unknown = JSON.parse(data.slice(5));
    return isRecord(frame) ? frame.result : null;
  };
  const search = async () => {
    const result = await callTool("search_capabilities", { query: "mock echo", limit: 20 });
    const payload = toolResultJson(result);
    return Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
  };
  return {
    web,
    den,
    connector,
    connection,
    toolTesterUrl: `${den.ref.webUrl}/dashboard/tool-tester?connectionId=${encodeURIComponent(connection.id)}`,
    search,
    execute: (schemaDigest: string, text: string) => callTool("execute_capability", {
      name: `mcp:${connection.id}:mock_echo`, schemaDigest, body: { text },
    }),
    /** The Tool Tester link destination for this connection. */
    // TODO(primitive): read a visible link destination by test id.
    async testToolsHref(): Promise<string> {
      const value = await seed.evalIn(web, browserScript((connectionId) => document.querySelector<HTMLElement>('[data-testid="test-mcp-tools-' + connectionId + '"]')?.getAttribute("href") ?? "", [connection.id]));
      return typeof value === "string" ? value : "";
    },
    /** Whether Tool Tester appears in Manage rather than Settings. */
    // TODO(primitive): identify a nav item's containing sidebar group.
    async toolTesterSidebarPlacement(): Promise<{ inManage: boolean; inSettings: boolean }> {
      const value = await seed.evalIn(web, () => {
        const sidebar = document.querySelector<HTMLElement>('[data-testid="den-org-sidebar"]');
        const links = sidebar ? [...sidebar.querySelectorAll('a')] : [];
        const toolTester = links.find((link) => link.textContent?.trim() === "Tool Tester");
        const settings = links.find((link) => link.textContent?.trim() === "Settings");
        return {
          inManage: toolTester?.closest('[data-sidebar-section="manage"]') != null,
          inSettings: settings?.parentElement?.contains(toolTester ?? null) ?? false,
        };
      });
      if (!isRecord(value) || typeof value.inManage !== "boolean" || typeof value.inSettings !== "boolean") {
        throw new Error(`Expected Tool Tester sidebar placement booleans, received ${JSON.stringify(value)}.`);
      }
      return { inManage: value.inManage, inSettings: value.inSettings };
    },
    /** The current web location. */
    async location(): Promise<string> {
      const value = await seed.evalIn(web, () => (location.href));
      if (typeof value !== "string") throw new Error("Expected the web location to be a string.");
      return value;
    },
    /** The checked states of the arguments editor modes by label. */
    // TODO(primitive): assert selected and unselected radio state.
    async argumentsEditorModes(): Promise<Record<string, string | null>> {
      const value = await seed.evalIn(web, () => {
        const editor = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Arguments editor mode"]');
        const radios = editor ? [...editor.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
        return Object.fromEntries(radios.map((radio) => [(radio.textContent ?? "").trim(), radio.getAttribute("aria-checked")]));
      });
      if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string" || entry === null)) {
        throw new Error(`Expected arguments editor modes, received ${JSON.stringify(value)}.`);
      }
      const modes: Record<string, string | null> = {};
      for (const [label, checked] of Object.entries(value)) {
        if (typeof checked === "string" || checked === null) modes[label] = checked;
      }
      return modes;
    },
    /** The selected Tool call inspection tab's label. */
    // TODO(primitive): assert the selected result tab state.
    async selectedInspectionTab(): Promise<string> {
      const value = await seed.evalIn(web, () => (document.querySelector<HTMLElement>('[aria-label="Tool call inspection"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ""));
      return typeof value === "string" ? value : "";
    },
    /** The organization tools switch's checked state. */
    // TODO(primitive): assert a visible switch's checked state.
    async orgToolsSwitchChecked(): Promise<string | null> {
      const value = await seed.evalIn(web, () => (document.querySelector<HTMLElement>('[role="switch"][aria-label="Tools enabled for your organization"]')?.getAttribute("aria-checked")));
      return typeof value === "string" ? value : null;
    },
    /** The arguments editor's nested-schema fallback state. */
    // TODO(primitive): assert disabled and selected radio state.
    async argumentsEditorFallback(): Promise<{ formDisabled: boolean; jsonChecked: string }> {
      const value = await seed.evalIn(web, () => {
        const editor = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Arguments editor mode"]');
        const radios = editor ? [...editor.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
        const form = radios.find((radio) => (radio.textContent ?? "").trim() === "Form");
        const json = radios.find((radio) => (radio.textContent ?? "").trim() === "JSON");
        return { formDisabled: form?.hasAttribute("disabled") ?? false, jsonChecked: json?.getAttribute("aria-checked") ?? "" };
      });
      if (!isRecord(value) || typeof value.formDisabled !== "boolean" || typeof value.jsonChecked !== "string") {
        throw new Error(`Expected arguments editor fallback state, received ${JSON.stringify(value)}.`);
      }
      return { formDisabled: value.formDisabled, jsonChecked: value.jsonChecked };
    },
    /** Whether the Run tool button is disabled. */
    // TODO(primitive): assert a visible button's disabled state.
    async runToolDisabled(): Promise<boolean> {
      return await seed.evalIn(web, () => ([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Run tool" && button.disabled))) === true;
    },
  };
}

export async function managedVaultWorld(_seed: Seed, { place }: { place: Place }) {
  const stamp = Date.now();
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-vault-recovery-"));
  const workspacePath = join(tmpdir(), `openwork-vault-recovery-ws-${stamp}`);
  const names = { managedA: `vault-a-${stamp}`, managedB: `vault-b-${stamp}`, plain: `plain-${stamp}` };
  const keys = {
    one: `openwork-eval-secure-storage-key-one-${stamp}`,
    two: `openwork-eval-secure-storage-key-two-${stamp}`,
  };
  const mock = await startMockMcp({ port: await allocateFreePort() });
  let app = await desktop({ name: "managed-vault-recovery", host: place.host(), profileDir, env: { OPENWORK_ENCRYPTION_KEY: keys.one } });
  const workspace = await createAndSelectWorkspace(app, { path: workspacePath });
  const serverTarget = async (surface = app) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const info = await evalIn(surface, () => (window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo")), {
        awaitPromise: true,
        timeoutMs: 15_000,
      }).catch(() => null);
      if (isRecord(info)) {
        const baseUrl = String(info.baseUrl ?? info.connectUrl ?? "").replace(/\/+$/, "");
        const token = String(info.ownerToken ?? info.clientToken ?? "");
        if (baseUrl && token) return { baseUrl, token };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    throw new Error("embedded openwork-server credentials not ready");
  };
  const api = async (target: { baseUrl: string; token: string }, method: string, path: string, payload?: unknown) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${target.token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const completeOAuth = async (authorizeUrl: string) => {
    const authorization = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const callbackUrl = authorization.headers.get("location");
    if (authorization.status !== 302 || !callbackUrl) throw new Error("The mock IdP did not redirect to a callback URL.");
    if (!callbackUrl.includes("/mcp/oauth/callback")) throw new Error(`Managed OAuth returned an unexpected callback URL: ${callbackUrl}`);
    const callback = await fetch(callbackUrl, { signal: AbortSignal.timeout(20_000) });
    if (!callback.ok) throw new Error(`Managed OAuth callback failed: ${callback.status}`);
  };
  const managedPath = (name: string) => `/workspace/${encodeURIComponent(workspace.workspaceId)}/mcp/${encodeURIComponent(name)}/managed`;
  const waitManaged = async (target: { baseUrl: string; token: string }, name: string, wanted: string) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await api(target, "GET", managedPath(name));
      if (isRecord(result.body) && result.body.status === wanted) return result.body;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    throw new Error(`Managed connection ${name} did not reach ${wanted}.`);
  };
  const firstTarget = await serverTarget(app);
  const workspaceMcpPath = `/workspace/${encodeURIComponent(workspace.workspaceId)}/mcp`;
  for (const name of [names.managedA, names.managedB]) {
    const started = await api(firstTarget, "POST", `${workspaceMcpPath}/managed`, {
      name,
      url: mock.mcpUrl,
      oauth: { applicationType: "native", requestedScopes: ["mcp:read", "mcp:write"] },
    });
    if (started.status !== 201 || !isRecord(started.body) || started.body.status !== "needs_auth" || typeof started.body.authorizeUrl !== "string") {
      throw new Error(`Could not create managed MCP ${name}: ${JSON.stringify(started.body)}`);
    }
    await completeOAuth(started.body.authorizeUrl);
    const connected = await waitManaged(firstTarget, name, "connected");
    if (connected.hasCredential !== true || connected.enabled !== true) {
      throw new Error(`Managed MCP ${name} did not retain its credential: ${JSON.stringify(connected)}`);
    }
  }
  const plain = await api(firstTarget, "POST", workspaceMcpPath, {
    name: names.plain,
    config: { type: "remote", url: mock.mcpUrl, enabled: true, oauth: false },
  });
  if (plain.status !== 200) throw new Error(`Could not add ordinary MCP: ${JSON.stringify(plain.body)}`);
  const relaunch = async () => {
    await app.stop();
    app = await desktop({ name: "managed-vault-recovery", host: place.host(), profileDir, env: { OPENWORK_ENCRYPTION_KEY: keys.two } });
    return app;
  };
  const openMcpSettings = async (surface = app) => {
    await go(surface, `/workspace/${workspace.workspaceId}/settings/mcp`);
  };
  const reconnect = async (target: { baseUrl: string; token: string }, name: string) => {
    const restarted = await api(target, "POST", `${managedPath(name)}/connect`);
    if (restarted.status !== 200 || !isRecord(restarted.body) || typeof restarted.body.authorizeUrl !== "string") {
      throw new Error(`Could not reconnect ${name}: ${JSON.stringify(restarted.body)}`);
    }
    await completeOAuth(restarted.body.authorizeUrl);
    return waitManaged(target, name, "connected");
  };
  const vaultFiles = async () => (await readdir(profileDir, { recursive: true }))
    .map(String)
    .filter((entry) => entry.endsWith("local-managed-mcp-vault.json"))
    .map((entry) => join(profileDir, entry));
  return {
    app,
    mock,
    profileDir,
    workspacePath,
    workspace,
    names,
    serverTarget,
    api,
    managedPath,
    workspaceMcpPath,
    waitManaged,
    firstTarget,
    relaunch,
    openMcpSettings,
    reconnect,
    vaultFiles,
    async [Symbol.asyncDispose]() {
      await app.stop().catch(() => undefined);
      await mock[Symbol.asyncDispose]();
      await rm(profileDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

declare global {
  interface Window {
    __backgroundUpdateInstallAttempts: number;
  }
}

export async function backgroundUpdateWorld(seed: Seed) {
  const app = await seed.desktop({ name: "background-update", signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("background-update"));
  await evalIn(app, async () => {
    const currentVersion = "0.18.0";
    const now = Date.now.bind(Date);
    const state: Window["__backgroundUpdateWitness"] = { checks: 0, downloads: 0, installs: 0, offset: 0, finishDownload: null, intervalCheck: null };
    window.__backgroundUpdateWitness = state;
    window.__backgroundUpdateInstallAttempts = 0;
    const schedule = window.setInterval.bind(window);
    // The browser timer returns a numeric handle; Node's merged ambient overload does not apply here.
    const browserWindow: Window = window;
    browserWindow.setInterval = (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15 * 60 * 1000 && typeof callback === "function") state.intervalCheck = () => callback(...args);
      return schedule(callback, delay, ...args);
    };
    Date.now = () => now() + state.offset;
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.1.0", latestAppVersion: "9.9.9", publishedDesktopVersions: ["9.9.9"],
    });
    window.__openworkApplyDesktopConfig?.({});
    window.__openworkSetDesktopConfigRefreshResult?.({});
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: "stable", currentVersion }),
      setChannel: async (channel) => ({ channel, currentVersion }),
      check: async () => {
        state.checks++;
        return { available: state.checks >= 4, channel: "stable", currentVersion, latestVersion: state.checks >= 4 ? "9.9.9" : currentVersion };
      },
      download: async () => {
        state.downloads++;
        const attempt = state.downloads;
        return new Promise((resolve, reject) => {
          state.finishDownload = () => {
            state.finishDownload = null;
            if (attempt === 1) resolve({ ok: false, reason: "Update native preparation failed." });
            else if (attempt === 2) reject(new Error("Update download connection failed."));
            else resolve({ ok: true });
          };
        });
      },
      // Witness renderer handling of bridge outcomes, not native installer behavior.
      installAndRestart: async () => {
        const attempt = ++window.__backgroundUpdateInstallAttempts;
        if (attempt === 1) return { ok: false, reason: "Update installer could not start." };
        if (attempt === 2) throw new Error("Update installer connection failed.");
        state.installs++;
        return { ok: true };
      },
      onDownloadProgress: () => () => {},
    };
    state.offset += 16 * 60 * 1000;
    window.dispatchEvent(new Event("focus"));
  }, { awaitPromise: true });
  return {
    app,
    snapshot: () => evalIn(app, () => {
      const { checks, downloads, installs } = window.__backgroundUpdateWitness;
      return {
        checks, downloads, installs, route: location.hash,
        installAttempts: window.__backgroundUpdateInstallAttempts,
        updateInTitlebar: Boolean(document.querySelector<HTMLElement>('header [data-update-button]')),
        updateInSidebar: Boolean(document.querySelector<HTMLElement>('[data-sidebar="footer"] [data-update-button]')),
        sidebarName: document.querySelector<HTMLElement>('[data-sidebar-brand]')?.textContent?.trim() ?? null,
        customLogoLoaded: Boolean(document.querySelector<HTMLImageElement>('[data-testid="brand-logo"] img')?.naturalWidth),
      };
    }),
    setCustomBranding: () => evalIn(app, () => {
      const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="5" fill="#25262b"/><text x="12" y="22" font-family="sans-serif" font-size="18" fill="white">Studio</text></svg>');
      window.__openworkApplyDesktopConfig({ brandAppName: "Studio", brandLogoUrl: logo });
    }),
    tickUpdateInterval: () => evalIn(app, () => {
      const state = window.__backgroundUpdateWitness;
      if (!state.intervalCheck) throw new Error("Update interval was not registered");
      state.offset += 15 * 60 * 1000;
      state.intervalCheck();
    }),
    finishDownload: () => evalIn(app, () => {
      const finish = window.__backgroundUpdateWitness.finishDownload;
      if (!finish) throw new Error("No update download is pending");
      finish();
    }),
    returnToApp: () => evalIn(app, () => {
      window.__backgroundUpdateWitness.offset += 16 * 60 * 1000;
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    }),
    openSettings: () => go(app, `/workspace/${workspace.workspaceId}/settings/updates`),
    openWorkspace: () => go(app, `/workspace/${workspace.workspaceId}/session`),
  };
}
