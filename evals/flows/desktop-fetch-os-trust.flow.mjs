import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "desktop-fetch-os-trust";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const HTTP_REMOTE_WORKSPACE_ID = "ws_fraimz_remote";
const HTTP_REMOTE_WORKSPACE_NAME = "Fraimz remote worker";
const REMOTE_URL_INPUT = 'input[placeholder="https://worker.example.com"]';
const WELCOME_FOLDER_INPUT = 'input[placeholder="/workspace/my-project"]';

const state = {
  originalDeveloperMode: null,
  originalPreferences: null,
  startedFromWelcome: false,
  previousWorkspaceCaptured: false,
  selfSignedServer: null,
  selfSignedServerUrl: null,
  selfSignedServerDir: null,
  httpServer: null,
  httpServerUrl: null,
  previousWorkspaceId: null,
  starterWorkspaceDir: null,
  starterWorkspaceId: null,
  createdWorkspaceId: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigateToSettingsTab(ctx, tab) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, {
    timeoutMs: 30_000,
    label: `${tab} settings route`,
  });
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", {
    timeoutMs: 30_000,
    label: "settings surface mounted",
  });
}

async function closeStaleDialogs(ctx) {
  const clicked = await ctx.eval(`(() => {
    const text = document.body?.innerText ?? '';
    if (!text.includes('Remote server details') && !text.includes('Create Workspace')) return false;
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Cancel')
      ?? buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Close');
    button?.click();
    return Boolean(button);
  })()`);
  await ctx.eval(`(() => {
    const first = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    const second = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(first);
    document.dispatchEvent(second);
    return true;
  })()`);
  if (clicked) {
    await ctx.waitFor(
      "(() => { const text = document.body?.innerText ?? ''; return !text.includes('Remote server details') && !text.includes('Create Workspace'); })()",
      { timeoutMs: 10_000, label: "stale dialog closed" },
    ).catch(() => {});
  }
}

async function dismissOpenWorkModelsDialog(ctx) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Continue without OpenWork Models');
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked) await sleep(300);
}

async function clickExactButtonIfPresent(ctx, label) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(label)} && !candidate.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked) await sleep(300);
  return clicked;
}

async function ensureDeveloperMode(ctx) {
  const current = await ctx.eval("window.localStorage.getItem('openwork.developerMode')");
  if (state.originalDeveloperMode === null) state.originalDeveloperMode = current;
  if (current === "1") return;

  await navigateToSettingsTab(ctx, "advanced");
  await ctx.waitForText("Developer mode", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const switchButton = [...document.querySelectorAll('button, [role="switch"]')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes('Developer mode'));
    if (!switchButton) throw new Error('Developer mode switch not found');
    switchButton.scrollIntoView({ block: 'center' });
    switchButton.click();
    return true;
  })()`);
  await ctx.waitFor("window.localStorage.getItem('openwork.developerMode') === '1'", {
    timeoutMs: 10_000,
    label: "developer mode enabled",
  });
}

async function restoreDeveloperMode(ctx) {
  if (state.originalDeveloperMode === null || state.originalDeveloperMode === "1") return;
  if (state.startedFromWelcome && !state.previousWorkspaceId) {
    await ctx.navigateHash("/settings/advanced");
    await ctx.waitFor("window.location.hash.includes('/settings/advanced')", {
      timeoutMs: 30_000,
      label: "advanced settings route",
    });
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", {
      timeoutMs: 30_000,
      label: "settings surface mounted",
    });
  } else {
    await navigateToSettingsTab(ctx, "advanced");
  }
  await ctx.waitForText("Developer mode", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const switchButton = [...document.querySelectorAll('button, [role="switch"]')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes('Developer mode'));
    if (!switchButton) throw new Error('Developer mode switch not found');
    switchButton.scrollIntoView({ block: 'center' });
    switchButton.click();
    return true;
  })()`);
  await ctx.waitFor("window.localStorage.getItem('openwork.developerMode') !== '1'", {
    timeoutMs: 10_000,
    label: "developer mode restored",
  });
}

async function openCloudAccount(ctx) {
  await navigateToSettingsTab(ctx, "cloud-account");
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      return text.includes('OpenWork Cloud') && (
        text.includes('Sign in') ||
        text.includes('Sign out') ||
        text.includes('Connected') ||
        text.includes('Select an organization') ||
        text.includes('Cloud account') ||
        text.includes('Cloud control plane URL')
      );
    })()`,
    { timeoutMs: 30_000, label: "cloud account controls" },
  );
}

async function returnToApp(ctx) {
  const inSettings = await ctx.eval("(document.body?.innerText ?? '').includes('Back to app')");
  if (inSettings) {
    await ctx.clickText("Back to app", { selector: "button", timeoutMs: 10_000 });
  }
  await dismissOpenWorkModelsDialog(ctx);
  await ctx.waitFor("(() => { const text = document.body?.innerText ?? ''; return text.includes('Add workspace') || text.includes('Welcome to OpenWork'); })()", {
    timeoutMs: 30_000,
    label: "workspace shell or welcome screen",
  });
}

async function ensureWorkspaceShellForRemote(ctx) {
  await rememberPreviousWorkspace(ctx);
  await returnToApp(ctx);
  const onWelcome = await ctx.eval("location.hash.includes('/welcome') || (document.body?.innerText ?? '').includes('Welcome to OpenWork')");
  if (onWelcome) {
    state.startedFromWelcome = true;
    if (state.originalPreferences === null) {
      state.originalPreferences = await ctx.eval("localStorage.getItem('openwork.preferences')");
    }
    await createStarterWorkspaceFromWelcome(ctx);
  }
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Add workspace')", {
    timeoutMs: 60_000,
    label: "session sidebar with Add workspace",
  });
}

async function openConnectRemoteDialog(ctx) {
  await ensureWorkspaceShellForRemote(ctx);
  await closeStaleDialogs(ctx);
  await dismissOpenWorkModelsDialog(ctx);
  await ctx.clickText("Add workspace", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText("Create Workspace", { timeoutMs: 30_000 });
  await ctx.clickText("Connect custom remote", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText("Remote server details", { timeoutMs: 30_000 });
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(REMOTE_URL_INPUT)}))`, {
    timeoutMs: 10_000,
    label: "remote worker URL input",
  });
}

async function createStarterWorkspaceFromWelcome(ctx) {
  const starterDir = await mkdtemp(join(tmpdir(), "openwork-fraimz-starter-"));
  state.starterWorkspaceDir = starterDir;

  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(WELCOME_FOLDER_INPUT)}))`, {
    timeoutMs: 30_000,
    label: "welcome manual folder input",
  });
  const filled = await ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(WELCOME_FOLDER_INPUT)});
    if (!(input instanceof HTMLInputElement)) return '';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(starterDir)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(starterDir)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  ctx.assert(filled === starterDir, `Expected welcome folder input to contain ${starterDir}, got ${filled}.`);
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Use this folder');
    return Boolean(button && !button.disabled);
  })()`, { timeoutMs: 10_000, label: "Use this folder enabled" });
  await ctx.clickText("Use this folder", { selector: "button", timeoutMs: 10_000 });
  const starterWorkspace = await waitForWorkspacePath(ctx, starterDir);
  state.starterWorkspaceId = starterWorkspace.id;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ready = await ctx.eval("(document.body?.innerText ?? '').includes('Add workspace')");
    if (ready) return;
    await dismissOpenWorkModelsDialog(ctx);
    await clickExactButtonIfPresent(ctx, "Skip and use the free model");
    await clickExactButtonIfPresent(ctx, "Skip");
    await sleep(500);
  }
}

async function startSelfSignedOpenworkServer() {
  if (state.selfSignedServerUrl) return state.selfSignedServerUrl;

  const dir = await mkdtemp(join(tmpdir(), "openwork-self-signed-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);

  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const server = createHttpsServer({ key, cert }, openworkDiscoveryHandler("ws_self_signed", "Self-signed remote", "/srv/self-signed"));
  await listen(server);
  state.selfSignedServer = server;
  state.selfSignedServerDir = dir;
  state.selfSignedServerUrl = `https://127.0.0.1:${server.address().port}`;
  return state.selfSignedServerUrl;
}

async function stopSelfSignedOpenworkServer() {
  const server = state.selfSignedServer;
  state.selfSignedServer = null;
  state.selfSignedServerUrl = null;
  if (server) await closeServer(server);
  if (state.selfSignedServerDir) {
    await rm(state.selfSignedServerDir, { recursive: true, force: true });
    state.selfSignedServerDir = null;
  }
}

async function startHttpOpenworkServer() {
  if (state.httpServerUrl) return state.httpServerUrl;

  const server = createHttpServer(openworkDiscoveryHandler(HTTP_REMOTE_WORKSPACE_ID, HTTP_REMOTE_WORKSPACE_NAME, "/srv/fraimz-remote"));
  await listen(server);
  state.httpServer = server;
  state.httpServerUrl = `http://127.0.0.1:${server.address().port}`;
  return state.httpServerUrl;
}

async function stopHttpOpenworkServer() {
  const server = state.httpServer;
  state.httpServer = null;
  state.httpServerUrl = null;
  if (server) await closeServer(server);
}

function openworkDiscoveryHandler(id, name, path) {
  return (request, response) => {
    if (request.url?.startsWith("/workspaces")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        workspaces: [{ id, name, path }],
        activeId: id,
      }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function desktopWorkspaceList(ctx) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 30_000,
    label: "desktop bridge",
  });
  return ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceBootstrap')", { awaitPromise: true });
}

async function forgetDesktopWorkspace(ctx, workspaceId) {
  await ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceForget', ${JSON.stringify(workspaceId)})`, {
    awaitPromise: true,
  });
}

async function deleteOpenworkServerWorkspace(ctx, workspaceId) {
  if (!workspaceId) return;
  await ctx.eval(`(async () => {
    const baseUrl = localStorage.getItem('openwork.server.urlOverride') || localStorage.getItem('openwork.server.active');
    if (!baseUrl || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return null;
    const token = localStorage.getItem('openwork.server.token') || '';
    const hostToken = localStorage.getItem('openwork.server.hostToken') || '';
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    if (hostToken) headers['x-openwork-host-token'] = hostToken;
    return window.__OPENWORK_ELECTRON__.invokeDesktop('__fetch', baseUrl.replace(/\/+$/, '') + '/workspaces/' + encodeURIComponent(${JSON.stringify(workspaceId)}), {
      method: 'DELETE',
      headers,
      timeoutMs: 8_000,
    });
  })()`, { awaitPromise: true }).catch(() => null);
}

async function restartOpenworkServer(ctx) {
  await ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerRestart', {})", { awaitPromise: true }).catch(() => null);
}

function isEvalStarterWorkspace(workspace) {
  const workspacePath = String(workspace?.path ?? "");
  return workspacePath.includes("/openwork-fraimz-starter-") || workspacePath.includes("\\openwork-fraimz-starter-");
}

function isEvalStarterPath(value) {
  return String(value ?? "").includes("openwork-fraimz-starter-");
}

function desktopUserDataDir() {
  const appId = "com.differentai.openwork.dev";
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", appId);
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), appId);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), appId);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pruneEvalStarterRecoveryStores() {
  const userDataDir = desktopUserDataDir();
  const workspaceStatePath = join(userDataDir, "openwork-workspaces.json");
  const workspaceState = await readJson(workspaceStatePath, null);
  if (workspaceState && Array.isArray(workspaceState.workspaces)) {
    const workspaces = workspaceState.workspaces.filter((workspace) => !isEvalStarterPath(workspace?.path));
    if (workspaces.length !== workspaceState.workspaces.length) {
      const selectedId = workspaces.some((workspace) => workspace?.id === workspaceState.selectedId) ? workspaceState.selectedId : "";
      await writeJson(workspaceStatePath, {
        ...workspaceState,
        selectedId,
        watchedId: selectedId || null,
        activeId: selectedId || null,
        selectedWorkspaceId: selectedId,
        watchedWorkspaceId: selectedId,
        workspaces,
      });
    }
  }

  const tokenStorePath = join(userDataDir, "openwork-server-tokens.json");
  const tokenStore = await readJson(tokenStorePath, null);
  if (tokenStore?.workspaces && typeof tokenStore.workspaces === "object") {
    const workspaces = Object.fromEntries(Object.entries(tokenStore.workspaces).filter(([workspacePath]) => !isEvalStarterPath(workspacePath)));
    if (Object.keys(workspaces).length !== Object.keys(tokenStore.workspaces).length) {
      await writeJson(tokenStorePath, { ...tokenStore, workspaces });
    }
  }

  const serverStatePath = join(userDataDir, "openwork-server-state.json");
  const serverState = await readJson(serverStatePath, null);
  if (serverState?.workspacePorts && typeof serverState.workspacePorts === "object") {
    const workspacePorts = Object.fromEntries(Object.entries(serverState.workspacePorts).filter(([workspacePath]) => !isEvalStarterPath(workspacePath)));
    if (Object.keys(workspacePorts).length !== Object.keys(serverState.workspacePorts).length) {
      await writeJson(serverStatePath, { ...serverState, workspacePorts });
    }
  }

  for (const serverConfigPath of [
    join(userDataDir, "openwork-dev-data", "xdg", "config", "openwork", "server.json"),
    join(userDataDir, "openwork-dev-data", "home", ".config", "openwork", "server.json"),
  ]) {
    const serverConfig = await readJson(serverConfigPath, null);
    if (!serverConfig) continue;
    const workspaces = Array.isArray(serverConfig.workspaces)
      ? serverConfig.workspaces.filter((workspace) => !isEvalStarterPath(workspace?.path))
      : serverConfig.workspaces;
    const authorizedRoots = Array.isArray(serverConfig.authorizedRoots)
      ? serverConfig.authorizedRoots.filter((workspacePath) => !isEvalStarterPath(workspacePath))
      : serverConfig.authorizedRoots;
    if (workspaces !== serverConfig.workspaces || authorizedRoots !== serverConfig.authorizedRoots) {
      await writeJson(serverConfigPath, { ...serverConfig, workspaces, authorizedRoots });
    }
  }
}

async function cleanupEvalStarterWorkspaces(ctx) {
  let removed = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const list = await desktopWorkspaceList(ctx).catch(() => null);
    const leftovers = (list?.workspaces ?? []).filter((workspace) => {
      return workspace?.id && workspace.id !== state.previousWorkspaceId && isEvalStarterWorkspace(workspace);
    });
    if (leftovers.length === 0) return removed;
    for (const workspace of leftovers) {
      await deleteOpenworkServerWorkspace(ctx, workspace.id);
      await forgetDesktopWorkspace(ctx, workspace.id);
      if (workspace.path) await rm(workspace.path, { recursive: true, force: true });
      removed += 1;
    }
    await pruneEvalStarterRecoveryStores();
    await sleep(500);
  }
  return removed;
}

async function waitForWorkspacePath(ctx, workspacePath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const list = await desktopWorkspaceList(ctx);
    const workspace = (list?.workspaces ?? []).find((entry) => entry?.path === workspacePath);
    if (workspace?.id) return workspace;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for starter workspace at ${workspacePath}.`);
}

async function rememberPreviousWorkspace(ctx) {
  if (state.previousWorkspaceCaptured) return;
  state.previousWorkspaceCaptured = true;
  const list = await desktopWorkspaceList(ctx);
  state.previousWorkspaceId = String(list?.selectedId ?? list?.activeId ?? "").trim() || null;
}

async function cleanupCreatedWorkspace(ctx) {
  const list = await desktopWorkspaceList(ctx).catch(() => null);
  const created = (list?.workspaces ?? []).find((workspace) => workspace?.openworkWorkspaceId === HTTP_REMOTE_WORKSPACE_ID)
    ?? (state.createdWorkspaceId ? { id: state.createdWorkspaceId } : null);
  if (created?.id) {
    await forgetDesktopWorkspace(ctx, created.id);
  }
  const starter = (list?.workspaces ?? []).find((workspace) => {
    return workspace?.id === state.starterWorkspaceId || workspace?.path === state.starterWorkspaceDir;
  }) ?? (state.starterWorkspaceId ? { id: state.starterWorkspaceId } : null);
  if (starter?.id && starter.id !== state.previousWorkspaceId && starter.id !== created?.id) {
    await deleteOpenworkServerWorkspace(ctx, starter.id);
    await forgetDesktopWorkspace(ctx, starter.id);
  }
  if (state.starterWorkspaceDir) {
    await rm(state.starterWorkspaceDir, { recursive: true, force: true });
  }
  await pruneEvalStarterRecoveryStores();
  await cleanupEvalStarterWorkspaces(ctx);
  if (state.startedFromWelcome && !state.previousWorkspaceId) {
    await restartOpenworkServer(ctx);
  }
  if (state.previousWorkspaceId) {
    await ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceSetSelected', ${JSON.stringify(state.previousWorkspaceId)})`, {
      awaitPromise: true,
    });
    await ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceSetRuntimeActive', ${JSON.stringify(state.previousWorkspaceId)})`, {
      awaitPromise: true,
    });
  }
  state.createdWorkspaceId = null;
  state.starterWorkspaceDir = null;
  state.starterWorkspaceId = null;
}

async function restoreFreshWelcome(ctx) {
  if (!state.startedFromWelcome || state.previousWorkspaceId) return;
  await cleanupEvalStarterWorkspaces(ctx);
  await ctx.eval(`(() => {
    const original = ${JSON.stringify(state.originalPreferences)};
    if (original === null) {
      localStorage.setItem('openwork.preferences', JSON.stringify({ hasCompletedOnboarding: false }));
    } else {
      try {
        const prefs = JSON.parse(original);
        prefs.hasCompletedOnboarding = false;
        localStorage.setItem('openwork.preferences', JSON.stringify(prefs));
      } catch {
        localStorage.setItem('openwork.preferences', JSON.stringify({ hasCompletedOnboarding: false }));
      }
    }
    localStorage.removeItem('openwork.react.activeWorkspace');
    return true;
  })()`);
  await ctx.eval("(() => { window.location.hash = '/welcome'; window.location.reload(); return true; })()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after welcome restore reload",
  });
  await ctx.waitFor("location.hash.includes('/welcome')", {
    timeoutMs: 30_000,
    label: "welcome route restored",
  });
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Welcome to OpenWork')", {
    timeoutMs: 30_000,
    label: "welcome screen restored",
  });
  await ctx.eval("new Promise((resolve) => setTimeout(resolve, 800))", { awaitPromise: true });
  const removedLateStarter = await cleanupEvalStarterWorkspaces(ctx);
  if (removedLateStarter > 0) {
    await ctx.eval("(() => { localStorage.removeItem('openwork.react.activeWorkspace'); window.location.hash = '/welcome'; window.location.reload(); return true; })()");
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API after late starter cleanup reload",
    });
  }
  await ctx.waitFor("location.hash.includes('/welcome') && (document.body?.innerText ?? '').includes('Welcome to OpenWork')", {
    timeoutMs: 30_000,
    label: "welcome screen remained restored",
  });
}

function summarizeError(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return String(error);
  return {
    name: typeof error.name === "string" ? error.name : "",
    message: typeof error.message === "string" ? error.message : String(error),
    code: typeof error.code === "string" ? error.code : "",
    cause: error.cause ? summarizeError(error.cause) : null,
  };
}

async function nodeFetchFailure(url) {
  try {
    await fetch(`${url}/workspaces`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}

async function visibleRemoteError(ctx) {
  return ctx.eval(`(() => {
    const lines = (document.body?.innerText ?? '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /certificate|ERR_CERT|fetch failed|OpenWork server is unavailable/i.test(line)) ?? '';
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Desktop fetch uses OS trust plumbing and remote workers connect through desktop IPC",
  kind: "user-facing",
  spec: "evals/voiceovers/desktop-fetch-os-trust.md",
  steps: [
    {
      name: "Cloud account opens without a generic fetch failure",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl",
        });
        await cleanupCreatedWorkspace(ctx);
        await closeStaleDialogs(ctx);

        await ctx.prove("The Cloud account settings surface opens cleanly", {
          claim: "Settings → Account renders the OpenWork Cloud account controls and does not show a generic fetch failure.",
          voiceover: vo[0],
          action: async () => {
            await ensureDeveloperMode(ctx);
            await openCloudAccount(ctx);
          },
          assert: async () => {
            await ctx.expectText("OpenWork Cloud");
            await ctx.expectText("Cloud control plane URL");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: "cloud-account-ready",
            requireText: ["OpenWork Cloud", "Cloud control plane URL"],
            rejectText: ["fetch failed", "Something went wrong"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Remote worker certificate failure is descriptive",
      run: async (ctx) => {
        const serverUrl = await startSelfSignedOpenworkServer();

        await ctx.prove("Connecting a worker with an untrusted certificate shows the certificate cause", {
          claim: "The Connect remote dialog keeps the user in context and shows a certificate-specific HTTPS failure instead of collapsing to a bare fetch failure.",
          voiceover: vo[1],
          action: async () => {
            await openConnectRemoteDialog(ctx);
            await ctx.fill(REMOTE_URL_INPUT, serverUrl);
            await ctx.clickText("Connect remote", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor(
              "(() => { const text = document.body?.innerText ?? ''; return text.toLowerCase().includes('certificate') || text.includes('ERR_CERT'); })()",
              { timeoutMs: 30_000, label: "certificate-specific remote connection error" },
            );
          },
          assert: async () => {
            const errorText = await visibleRemoteError(ctx);
            ctx.assert(/certificate|ERR_CERT/i.test(errorText), `Expected a certificate-specific error, got: ${errorText}`);
            ctx.assert(!/TypeError:\s*fetch failed$/i.test(errorText), `Remote error was still a bare fetch failure: ${errorText}`);
            ctx.assert(!errorText.includes("OpenWork server is unavailable"), `Remote error was swallowed into a generic availability message: ${errorText}`);
            ctx.output("self-signed-fetch-differential.json", JSON.stringify({
              selfSignedServer: serverUrl,
              visibleDesktopError: errorText,
              nodeUndiciFetch: await nodeFetchFailure(serverUrl),
            }, null, 2));
          },
          screenshot: {
            name: "remote-certificate-error",
            requireText: ["Remote server details", "ERR_CERT_AUTHORITY_INVALID"],
            rejectText: ["OpenWork server is unavailable", "TypeError: fetch failed"],
          },
        });
      },
    },
    {
      name: "Healthy remote worker connects through desktop IPC",
      run: async (ctx) => {
        const serverUrl = await startHttpOpenworkServer();

        await ctx.prove("A valid remote worker is discovered, created, selected, and listed", {
          claim: "Connecting a healthy remote worker through the same desktop path closes the dialog and adds Fraimz remote worker to the workspace list.",
          voiceover: vo[2],
          action: async () => {
            await rememberPreviousWorkspace(ctx);
            await ctx.clickText("Cancel", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor("!(document.body?.innerText ?? '').includes('Remote server details')", {
              timeoutMs: 10_000,
              label: "remote dialog closed",
            });
            await openConnectRemoteDialog(ctx);
            await ctx.fill(REMOTE_URL_INPUT, serverUrl);
            await ctx.clickText("Connect remote", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor("!(document.body?.innerText ?? '').includes('Remote server details')", {
              timeoutMs: 30_000,
              label: "successful remote dialog close",
            });
            await ctx.waitFor(`(document.body?.innerText ?? '').includes(${JSON.stringify(HTTP_REMOTE_WORKSPACE_NAME)})`, {
              timeoutMs: 30_000,
              label: "remote workspace visible in sidebar",
            });
          },
          assert: async () => {
            await ctx.expectText(HTTP_REMOTE_WORKSPACE_NAME);
            await ctx.expectNoText("Remote server details");
            const list = await desktopWorkspaceList(ctx);
            const workspace = (list?.workspaces ?? []).find((entry) => entry?.openworkWorkspaceId === HTTP_REMOTE_WORKSPACE_ID);
            ctx.assert(Boolean(workspace), `Electron workspace store did not include ${HTTP_REMOTE_WORKSPACE_ID}.`);
            ctx.assert(workspace.remoteType === "openwork", `Expected remoteType openwork, got ${workspace.remoteType}.`);
            state.createdWorkspaceId = workspace.id;
            ctx.output("desktop-workspace-store-created.json", JSON.stringify({
              createdWorkspaceId: workspace.id,
              remoteType: workspace.remoteType,
              openworkWorkspaceId: workspace.openworkWorkspaceId,
              openworkWorkspaceName: workspace.openworkWorkspaceName,
              selectedId: list.selectedId ?? null,
            }, null, 2));
          },
          screenshot: {
            name: "remote-worker-connected",
            requireText: [HTTP_REMOTE_WORKSPACE_NAME],
            rejectText: ["Remote server details", "OpenWork server is unavailable", "fetch failed"],
          },
        });
      },
    },
    {
      name: "Cleanup returns the app to a healthy account page",
      run: async (ctx) => {
        await ctx.prove("After cleanup, the app returns to a healthy baseline", {
          claim: "The temporary worker is removed, any helper workspace is cleaned up, and the app returns to the settings or welcome baseline it started from.",
          voiceover: vo[3],
          action: async () => {
            await cleanupCreatedWorkspace(ctx);
            await stopHttpOpenworkServer();
            await stopSelfSignedOpenworkServer();
            await restoreDeveloperMode(ctx);
            if (state.startedFromWelcome && !state.previousWorkspaceId) {
              await restoreFreshWelcome(ctx);
            } else if (state.previousWorkspaceId) {
              await ctx.navigateHash(`/workspace/${state.previousWorkspaceId}/settings/cloud-account`);
              await ctx.waitFor("window.location.hash.includes('/settings/cloud-account')", {
                timeoutMs: 30_000,
                label: "restored cloud-account route",
              });
              await ctx.waitFor("(document.body?.innerText ?? '').includes('OpenWork Cloud')", {
                timeoutMs: 30_000,
                label: "cloud account content after cleanup",
              });
            } else {
              await openCloudAccount(ctx);
            }
          },
          assert: async () => {
            if (state.startedFromWelcome && !state.previousWorkspaceId) {
              await ctx.expectText("Welcome to OpenWork");
            } else {
              await ctx.expectText("OpenWork Cloud");
            }
            await ctx.expectNoText(HTTP_REMOTE_WORKSPACE_NAME);
            await ctx.expectNoText("Remote server details");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: state.startedFromWelcome && !state.previousWorkspaceId ? "welcome-recovered" : "cloud-account-recovered",
            requireText: state.startedFromWelcome && !state.previousWorkspaceId ? ["Welcome to OpenWork"] : ["OpenWork Cloud"],
            rejectText: [HTTP_REMOTE_WORKSPACE_NAME, "Remote server details", "fetch failed", "Something went wrong"],
            hashIncludes: state.startedFromWelcome && !state.previousWorkspaceId ? "/welcome" : "/settings/cloud-account",
          },
        });
      },
    },
  ],
};
