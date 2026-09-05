import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app as startApp, server as startServer } from "@openwork/env";
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
import { matchVerdictExpectations } from "@openwork/matchers";
import {
  assignPluginToMarketplace,
  captureOpenedUrls,
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
      return evalIn(app, `(async () => {
        const bridge = window.__OPENWORK_ELECTRON__;
        if (typeof bridge?.invokeDesktop !== "function") return { bridge: false };
        const info = await bridge.invokeDesktop("openworkServerInfo");
        const health = await fetch(info.baseUrl + "/health", { signal: AbortSignal.timeout(5000) });
        return { bridge: true, protocol: location.protocol, health: health.status,
          welcome: location.hash === "#/welcome" && [...document.querySelectorAll("button")]
            .some(button => button.textContent.trim() === "Use Without Cloud" && !button.disabled),
          crash: /Something went wrong|Cannot find module|Maximum update depth exceeded/.test(document.body.innerText) };
      })()`, { awaitPromise: true });
    },
    async [Symbol.asyncDispose]() { await app[Symbol.asyncDispose](); },
  };
}

export async function bareFirstRunWorld(seed: Seed, { place }: { place: Place }) {
  const capture = process.platform === "linux" && place.kind === "local" ? await captureOpenedUrls() : null;
  const app = capture
    ? await desktop({ name: "first-run", host: place.host(), env: { PATH: `${capture.binDir}:${process.env.PATH ?? ""}` } })
    : await seed.desktop({ name: "first-run", signIn: false });
  return {
    app,
    capture,
    workspacePath: seed.tmpPath("first-run-workspace"),
    async [Symbol.asyncDispose]() { await app[Symbol.asyncDispose](); },
  };
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

export async function parentChildPermissionWorld(seed: Seed) {
  const base = await sessionWorld(seed);
  // TODO(primitive): seed a child-session permission request and parent activity row.
  const seeded = await seed.evalIn(base.app, `(async () => {
    const child = await window.__openworkControl.execute("eval.child_permission.seed", null);
    if (!child?.ok || typeof child.result?.childSessionId !== "string") return child;
    const activity = await window.__openworkControl.execute("eval.task_activity.seed", {
      childSessionId: child.result.childSessionId,
    });
    return { child, activity };
  })()`, { awaitPromise: true });
  if (!isRecord(seeded) || !isRecord(seeded.child) || seeded.child.ok !== true
    || !isRecord(seeded.activity) || seeded.activity.ok !== true) {
    throw new Error(`Child permission seed failed: ${JSON.stringify(seeded)}`);
  }
  return base;
}

export async function artifactCodeBrowserWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const [session] = await seed.sessions(base.app, ["Artifact code browser proof"]);
  if (!session) throw new Error("Could not seed the artifact code browser session.");
  await go(base.app, `/workspace/${base.workspace.workspaceId}/session/${session.sessionId}`);
  // TODO(primitive): write workspace files through the local server fixture.
  const wrote = await seed.evalIn(base.app, `async (workspaceId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return false;
    const write = (path, content) => fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ path, content, baseUpdatedAt: null }),
      },
    );
    const responses = await Promise.all([
      write("src/openwork-artifact-proof.ts", "export const artifactEditor = true;\\n"),
      write("config/openwork-artifact-settings.json", "{\\"artifactEditor\\":true}\\n"),
    ]);
    return responses.every((response) => response.ok);
  }`, { args: [base.workspace.workspaceId], awaitPromise: true });
  if (wrote !== true) throw new Error("Could not seed artifact code files.");
  // TODO(primitive): open an initial built-in browser artifact tab.
  await seed.evalIn(base.app, `window.__openworkControl.execute("browser.open_url", { url: "about:blank" })`, { awaitPromise: true });
  await waitForBehavior(
    base.app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)`,
    { timeoutMs: 30_000, label: "artifact seed action enabled" },
  );
  // TODO(primitive): seed artifact tabs through a first-class artifact fixture.
  const tabs = await seed.evalIn(base.app, `window.__openworkControl.execute("eval.artifact_tabs.seed_overflow", { count: 12 })`, { awaitPromise: true });
  if (!isRecord(tabs) || tabs.ok !== true) throw new Error(`Could not seed artifact tabs: ${JSON.stringify(tabs)}`);
  return base;
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
  const switched = await evalIn(app, `(async () => {
    const state = { rawSeen: document.body.innerText.includes('{"code":') };
    const observer = new MutationObserver(() => {
      if (document.body.innerText.includes('{"code":')) state.rawSeen = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__issue3980NotificationProbe = { observer, state };
    localStorage.setItem("openwork.server.urlOverride", "http://127.0.0.1.nip.io:${port}");
    localStorage.setItem("openwork.server.token", ${JSON.stringify(serverToken)});
    localStorage.removeItem("openwork.server.hostToken");
    await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("engineStop");
    window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    return true;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
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
  const installed = await evalIn(app, `(() => {
    const nativeUpdater = window.__OPENWORK_ELECTRON__?.updater;
    if (!nativeUpdater?.getChannel || !nativeUpdater.setChannel) return false;
    const state = { checks: [], currentVersion: "0.18.37-alpha.2491+64d2d37", latestVersion: "0.18.37-alpha.2492+4921a02" };
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
  })()`);
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
  const snapshot = () => evalIn(app, `window.__openworkRecoveryControl.snapshot()`, { awaitPromise: true });
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
  const names = await evalIn(seeded, `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
    folderPath: ${JSON.stringify(`${profileDir}/continuity-workspace`)}, name: "reliable-recovery-profile-marker"
  }).then((state) => state.workspaces.map((workspace) => workspace.displayName))`, { awaitPromise: true });
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
  const snapshot = () => evalIn(app, `window.__openworkRecoveryControl.snapshot()`, { awaitPromise: true });
  const workspaceNames = () => evalIn(
    app,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap").then((state) => state.workspaces.map((entry) => entry.displayName))`,
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

async function installUpdaterRaceBridge(app: Awaited<ReturnType<typeof desktop>>, delayStable: boolean) {
  const installed = await evalIn(app, `(() => {
    const nativeUpdater = window.__OPENWORK_ELECTRON__?.updater;
    if (!nativeUpdater?.getChannel || !nativeUpdater.setChannel) return false;
    const state = { checks: [], setChannels: [], stableStarted: false, finishStable: null };
    window.__openworkUpdaterEvalState = state;
    window.__openworkApplyDesktopConfig?.({ allowAlphaUpdates: true });
    window.__openworkSetDesktopConfigRefreshResult?.({ allowAlphaUpdates: true });
    window.__openworkUpdaterEvalBridge = {
      getChannel: () => nativeUpdater.getChannel(),
      setChannel: async (channel) => { state.setChannels.push(channel); return nativeUpdater.setChannel(channel); },
      check: async (channel) => {
        state.checks.push(channel);
        if (${JSON.stringify(delayStable)} && channel === "stable") {
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
  })()`);
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
    await waitForBehavior(active, `window.location.hash.includes("/settings/updates") && Boolean(document.querySelector('[aria-label="Release channel"]'))`, {
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
      `(folderPath) => window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
        folderPath,
        name: "enterprise-tls-profile-continuity"
      }).then((state) => state.workspaces.map((workspace) => workspace.displayName))`,
      { args: [`${profileDir}/continuity-workspace`], awaitPromise: true },
    );
    if (!Array.isArray(seededWorkspaceNames) || !seededWorkspaceNames.includes("enterprise-tls-profile-continuity")) {
      throw new Error("Could not seed the enterprise TLS continuity workspace.");
    }
    await waitForBehavior(
      rawApp,
      `window.__openworkControl?.listActions?.().some((action) => action.id === "auth.exchange-grant")`,
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
      const value = await seed.evalIn(web, `(connectionId) => document.querySelector('[data-testid="test-mcp-tools-' + connectionId + '"]')?.getAttribute("href") ?? ""`, {
        args: [connection.id],
      });
      return typeof value === "string" ? value : "";
    },
    /** Whether Tool Tester appears in Manage rather than Settings. */
    // TODO(primitive): identify a nav item's containing sidebar group.
    async toolTesterSidebarPlacement(): Promise<{ inManage: boolean; inSettings: boolean }> {
      const value = await seed.evalIn(web, `(() => {
        const sidebar = document.querySelector('[data-testid="den-org-sidebar"]');
        const links = sidebar ? [...sidebar.querySelectorAll('a')] : [];
        const toolTester = links.find((link) => link.textContent?.trim() === "Tool Tester");
        const settings = links.find((link) => link.textContent?.trim() === "Settings");
        return {
          inManage: toolTester?.closest('[data-sidebar-section="manage"]') != null,
          inSettings: settings?.parentElement?.contains(toolTester ?? null) ?? false,
        };
      })()`);
      if (!isRecord(value) || typeof value.inManage !== "boolean" || typeof value.inSettings !== "boolean") {
        throw new Error(`Expected Tool Tester sidebar placement booleans, received ${JSON.stringify(value)}.`);
      }
      return { inManage: value.inManage, inSettings: value.inSettings };
    },
    /** The current web location. */
    async location(): Promise<string> {
      const value = await seed.evalIn(web, `location.href`);
      if (typeof value !== "string") throw new Error("Expected the web location to be a string.");
      return value;
    },
    /** The checked states of the arguments editor modes by label. */
    // TODO(primitive): assert selected and unselected radio state.
    async argumentsEditorModes(): Promise<Record<string, string | null>> {
      const value = await seed.evalIn(web, `(() => {
        const editor = document.querySelector('[role="radiogroup"][aria-label="Arguments editor mode"]');
        const radios = editor ? [...editor.querySelectorAll('[role="radio"]')] : [];
        return Object.fromEntries(radios.map((radio) => [(radio.textContent ?? "").trim(), radio.getAttribute("aria-checked")]));
      })()`);
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
      const value = await seed.evalIn(web, `document.querySelector('[aria-label="Tool call inspection"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ""`);
      return typeof value === "string" ? value : "";
    },
    /** The organization tools switch's checked state. */
    // TODO(primitive): assert a visible switch's checked state.
    async orgToolsSwitchChecked(): Promise<string | null> {
      const value = await seed.evalIn(web, `document.querySelector('[role="switch"][aria-label="Tools enabled for your organization"]')?.getAttribute("aria-checked")`);
      return typeof value === "string" ? value : null;
    },
    /** The arguments editor's nested-schema fallback state. */
    // TODO(primitive): assert disabled and selected radio state.
    async argumentsEditorFallback(): Promise<{ formDisabled: boolean; jsonChecked: string }> {
      const value = await seed.evalIn(web, `(() => {
        const editor = document.querySelector('[role="radiogroup"][aria-label="Arguments editor mode"]');
        const radios = editor ? [...editor.querySelectorAll('[role="radio"]')] : [];
        const form = radios.find((radio) => (radio.textContent ?? "").trim() === "Form");
        const json = radios.find((radio) => (radio.textContent ?? "").trim() === "JSON");
        return { formDisabled: form?.hasAttribute("disabled") ?? false, jsonChecked: json?.getAttribute("aria-checked") ?? "" };
      })()`);
      if (!isRecord(value) || typeof value.formDisabled !== "boolean" || typeof value.jsonChecked !== "string") {
        throw new Error(`Expected arguments editor fallback state, received ${JSON.stringify(value)}.`);
      }
      return { formDisabled: value.formDisabled, jsonChecked: value.jsonChecked };
    },
    /** Whether the Run tool button is disabled. */
    // TODO(primitive): assert a visible button's disabled state.
    async runToolDisabled(): Promise<boolean> {
      return await seed.evalIn(web, `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Run tool" && button.disabled)`) === true;
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
      const info = await evalIn(surface, `window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo")`, {
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

export async function backgroundUpdateWorld(seed: Seed) {
  const app = await seed.desktop({ name: "background-update", signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("background-update"));
  await evalIn(app, `(async () => {
    const currentVersion = "0.18.0";
    const now = Date.now.bind(Date);
    const state = { checks: 0, downloads: 0, installs: 0, offset: 0, finishDownload: null, intervalCheck: null };
    window.__backgroundUpdateWitness = state;
    const schedule = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 15 * 60 * 1000) state.intervalCheck = callback;
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
        return new Promise(resolve => { state.finishDownload = () => resolve({ ok: true }); });
      },
      installAndRestart: async () => { state.installs++; return { ok: true }; },
      onDownloadProgress: () => () => {},
    };
    state.offset += 16 * 60 * 1000;
    window.dispatchEvent(new Event("focus"));
  })()`, { awaitPromise: true });
  return {
    app,
    snapshot: () => evalIn(app, `(() => {
      const { checks, downloads, installs } = window.__backgroundUpdateWitness;
      return {
        checks, downloads, installs, route: location.hash,
        updateInTitlebar: Boolean(document.querySelector('header [data-update-button]')),
        updateInSidebar: Boolean(document.querySelector('[data-sidebar="footer"] [data-update-button]')),
        sidebarName: document.querySelector('[data-sidebar-brand]')?.textContent?.trim() ?? null,
        customLogoLoaded: Boolean(document.querySelector('[data-testid="brand-logo"] img')?.naturalWidth),
      };
    })()`),
    setCustomBranding: () => evalIn(app, `(() => {
      const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="5" fill="#25262b"/><text x="12" y="22" font-family="sans-serif" font-size="18" fill="white">Studio</text></svg>');
      window.__openworkApplyDesktopConfig({ brandAppName: "Studio", brandLogoUrl: logo });
    })()`),
    tickUpdateInterval: () => evalIn(app, `(() => {
      const state = window.__backgroundUpdateWitness;
      if (!state.intervalCheck) throw new Error("Update interval was not registered");
      state.offset += 15 * 60 * 1000;
      state.intervalCheck();
    })()`),
    finishDownload: () => evalIn(app, `window.__backgroundUpdateWitness.finishDownload()`),
    returnToApp: () => evalIn(app, `(() => {
      window.__backgroundUpdateWitness.offset += 16 * 60 * 1000;
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    })()`),
    openSettings: () => go(app, `/workspace/${workspace.workspaceId}/settings/updates`),
    openWorkspace: () => go(app, `/workspace/${workspace.workspaceId}/session`),
  };
}
