import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "desktop-fetch-os-trust";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const HTTP_REMOTE_WORKSPACE_ID = "ws_fraimz_remote";
const HTTP_REMOTE_WORKSPACE_NAME = "Fraimz remote worker";
const REMOTE_URL_INPUT = 'input[placeholder="https://worker.example.com"]';

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

async function openWelcomeCreateWorkspaceModal(ctx) {
  await ctx.waitFor("location.hash.includes('/welcome') && (document.body?.innerText ?? '').includes('Welcome to OpenWork')", {
    timeoutMs: 30_000,
    label: "welcome route ready for create modal",
  });
  const opened = await ctx.eval(`(() => {
    const root = document.getElementById('root');
    const key = root ? Object.keys(root).find((candidate) => candidate.startsWith('__reactContainer$') || candidate.startsWith('__reactFiber$')) : '';
    const containerFiber = key ? root[key] : null;
    const start = containerFiber?.stateNode?.current ?? containerFiber;
    const stack = start ? [start] : [];
    while (stack.length > 0) {
      const fiber = stack.pop();
      for (let hook = fiber?.memoizedState; hook; hook = hook.next) {
        const value = hook.memoizedState;
        if (
          value &&
          typeof value === 'object' &&
          Object.prototype.hasOwnProperty.call(value, 'modalOpen') &&
          Object.prototype.hasOwnProperty.call(value, 'remoteError') &&
          typeof hook.queue?.dispatch === 'function'
        ) {
          hook.queue.dispatch({ type: 'open' });
          return true;
        }
      }
      if (fiber?.sibling) stack.push(fiber.sibling);
      if (fiber?.child) stack.push(fiber.child);
    }
    return false;
  })()`);
  ctx.assert(opened, "Welcome CreateWorkspaceModal reducer dispatch was not found.");
  await ctx.waitForText("Create Workspace", { timeoutMs: 30_000 });
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
    return "welcome";
  }
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Add workspace')", {
    timeoutMs: 60_000,
    label: "session sidebar with Add workspace",
  });
  return "workspace";
}

async function openConnectRemoteDialog(ctx) {
  const surface = await ensureWorkspaceShellForRemote(ctx);
  await closeStaleDialogs(ctx);
  await dismissOpenWorkModelsDialog(ctx);
  if (surface === "welcome") {
    await openWelcomeCreateWorkspaceModal(ctx);
  } else {
    await ctx.clickText("Add workspace", { selector: "button", timeoutMs: 30_000 });
    await ctx.waitForText("Create Workspace", { timeoutMs: 30_000 });
  }
  await ctx.clickText("Connect custom remote", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText("Remote server details", { timeoutMs: 30_000 });
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(REMOTE_URL_INPUT)}))`, {
    timeoutMs: 10_000,
    label: "remote worker URL input",
  });
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
    await ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceForget', ${JSON.stringify(created.id)})`, {
      awaitPromise: true,
    });
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
}

async function restoreFreshWelcome(ctx) {
  if (!state.startedFromWelcome || state.previousWorkspaceId) return;
  await ctx.eval(`(() => {
    const original = ${JSON.stringify(state.originalPreferences)};
    if (original === null) {
      localStorage.setItem('openwork.preferences', JSON.stringify({ hasCompletedOnboarding: false }));
      return true;
    }
    try {
      const prefs = JSON.parse(original);
      prefs.hasCompletedOnboarding = false;
      localStorage.setItem('openwork.preferences', JSON.stringify(prefs));
    } catch {
      localStorage.setItem('openwork.preferences', JSON.stringify({ hasCompletedOnboarding: false }));
    }
    return true;
  })()`);
  await ctx.navigateHash("/welcome");
  await ctx.waitFor("location.hash.includes('/welcome')", {
    timeoutMs: 30_000,
    label: "welcome route restored",
  });
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Welcome to OpenWork')", {
    timeoutMs: 30_000,
    label: "welcome screen restored",
  });
  await ctx.eval("new Promise((resolve) => setTimeout(resolve, 800))", { awaitPromise: true });
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
