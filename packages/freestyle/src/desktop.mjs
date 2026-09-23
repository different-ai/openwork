import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// Controller-owned: a virtual display, a VNC server bound to loopback, and the
// noVNC web client, all behind the preview gateway's own access check. The
// OpenWork desktop app itself comes from the reviewed commit in /workspace.
const DESKTOP_DISPLAY = ":99";
const NOVNC_PORT = 6080;
const VNC_PORT = 5900;
const CDP_PORT = 9825;
const DEN_FRONT_PORT = 5190;
const LOGS = "/opt/openwork-preview/desktop";
const DEN_PROXY_PREFIX = "/api/den";
const DESKTOP_WORKSPACE = "/root/Acme";

function service(stack, command, args, name) {
  const log = openSync(`${LOGS}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, { stdio: ["ignore", log, log], detached: true, env: { ...process.env, DISPLAY: DESKTOP_DISPLAY } });
  closeSync(log);
  child.unref();
  stack.defer(() => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } });
  return child;
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* not ready yet */ }
    await delay(500);
  }
  throw new Error(`Desktop ${label} did not become ready`);
}

function forward(req, res, target, path) {
  const upstream = request({ hostname: target.hostname, port: target.port, method: req.method, path,
    headers: { ...req.headers, host: target.host } }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
}

/**
 * Den advertises the snapshot's template origins (runtime-config `denApiUrl`
 * and `/api/den` redirects). Only the edge translates them, and only for
 * browsers; inside the VM they never answer, so the desktop's Den calls time
 * out. The desktop instead uses this loopback Den web origin, which keeps
 * every advertised Den address inside the VM. Browsers are unaffected.
 */
async function startDesktopDenFront(stack, den) {
  const web = new URL(den.webUrl);
  const api = new URL(den.apiUrl);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://desktop-den.invalid");
    if (req.method === "GET" && url.pathname === "/api/runtime-config") {
      try {
        const upstream = await fetch(new URL(`${url.pathname}${url.search}`, web), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        const config = await upstream.json();
        res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ...config, denApiUrl: den.apiUrl }));
      } catch {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      }
      return;
    }
    if (url.pathname === DEN_PROXY_PREFIX || url.pathname.startsWith(`${DEN_PROXY_PREFIX}/`)) {
      forward(req, res, api, `${url.pathname.slice(DEN_PROXY_PREFIX.length) || "/"}${url.search}`);
      return;
    }
    forward(req, res, web, `${url.pathname}${url.search}`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(DEN_FRONT_PORT, "127.0.0.1", resolve);
  });
  stack.defer(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return `http://127.0.0.1:${DEN_FRONT_PORT}`;
}

// A just-signed-in app can accept workspace creation before its engine is ready
// and drop it, so retry. Optional: a failure leaves a signed-in, empty app.
async function prepareWorkspace(surface, world, { createAndSelectWorkspace, selectModel }) {
  mkdirSync(DESKTOP_WORKSPACE, { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await createAndSelectWorkspace(surface, { path: DESKTOP_WORKSPACE });
      await selectModel(surface, world.model.modelName, { provider: "Acme AI Gateway" });
      return;
    } catch (error) {
      console.error(`Desktop workspace setup attempt ${attempt} failed:`, error);
      await delay(5_000);
    }
  }
}

// The app's default for new conversations (Settings > default model). Unset, it
// falls back to a public model the VM cannot reach, and sends time out.
async function setDefaultModel(surface, world, evalIn, browserScript) {
  const ref = `${world.model.providerId}/${world.model.modelId}`;
  await evalIn(surface, browserScript((value) => {
    localStorage.setItem("openwork.defaultModel", value);
    window.dispatchEvent(new Event("openwork.defaultModelChanged"));
  }, [ref]));
}

// Signs the running window in as the demo owner with the harness's own handoff,
// over the launcher's debug port, then opens a workspace so the app is ready to
// chat. Any sign-in failure leaves the real app signed out.
async function signIn(world, den) {
  try {
    const { attachSurface, browserScript } = await import("/workspace/evals/packages/cdp/src/index.ts");
    const { signInDesktopAs, createAndSelectWorkspace, selectModel, evalIn } = await import("/workspace/evals/packages/behaviors/src/index.ts");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const surface = await attachSurface({ name: "preview-desktop", kind: "electron", hostKind: "local", cdpUrl: `http://127.0.0.1:${CDP_PORT}` }, { timeoutMs: 60_000 });
      try {
        await signInDesktopAs(surface, den, world.den.admin);
        // Like the web preview, every new workspace and conversation starts on the
        // world's AI Gateway model instead of the app's public default model.
        await setDefaultModel(surface, world, evalIn, browserScript);
        await prepareWorkspace(surface, world, { createAndSelectWorkspace, selectModel });
        return true;
      }
      catch (error) { console.error(`Desktop sign-in attempt ${attempt} failed:`, error); }
      finally { await surface.stop().catch(() => undefined); }
    }
  } catch (error) { console.error("Desktop sign-in unavailable:", error); }
  return false;
}

/**
 * Starts the display and viewer (seconds), then boots the real desktop app and
 * signs it in as the demo owner when possible (otherwise it stays signed out).
 * `ready` resolves once its window is up, so the caller can snapshot a running desktop.
 */
export async function startDesktop(stack, world) {
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  mkdirSync("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
  service(stack, "Xvfb", [DESKTOP_DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], "xvfb");
  await waitFor(() => existsSync(`/tmp/.X11-unix/X${DESKTOP_DISPLAY.slice(1)}`), "display");
  service(stack, "startxfce4", [], "xfce");
  service(stack, "x11vnc", ["-display", DESKTOP_DISPLAY, "-localhost", "-rfbport", String(VNC_PORT), "-forever", "-shared", "-nopw", "-quiet"], "x11vnc");
  service(stack, "websockify", ["--web", "/usr/share/novnc", `127.0.0.1:${NOVNC_PORT}`, `127.0.0.1:${VNC_PORT}`], "novnc");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${NOVNC_PORT}/vnc.html`, { signal: AbortSignal.timeout(2_000) })).ok, "viewer");
  const status = (value) => writeFileSync(`${LOGS}/status`, value, { mode: 0o600 });
  status("starting");
  // Upstream's Linux desktop launcher (used by Daytona previews) runs the real
  // app from the reviewed commit. A relaunch loop and a deadline-free readiness
  // poll keep it working across the snapshot's pause and resume.
  const den = { ...world.den.ref, webUrl: await startDesktopDenFront(stack, world.den.ref) };
  writeFileSync(`${LOGS}/bootstrap.json`, JSON.stringify({ baseUrl: den.webUrl, apiBaseUrl: den.apiUrl, requireSignin: false }), { mode: 0o600 });
  const env = {
    ...process.env, DISPLAY: DESKTOP_DISPLAY, OPENWORK_WORKSPACE_DIR: "/workspace", PORT: "5186",
    OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: String(CDP_PORT), OPENWORK_DESKTOP_BOOTSTRAP_PATH: `${LOGS}/bootstrap.json`,
    OPENWORK_ELECTRON_USERDATA: "/root/.openwork-desktop", OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
    OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    // The snapshot builder already fetched the sidecars and helpers.
    OPENWORK_ELECTRON_SKIP_SHARED_PREPARE: "1",
    OPENWORK_ELECTRON_SKIP_WORKSPACE_BUILD: "1",
  };
  const launcher = existsSync("/workspace/.devcontainer/start-daytona-electron.sh")
    ? "bash /workspace/.devcontainer/start-daytona-electron.sh" : "pnpm --filter @openwork/desktop dev:electron";
  const log = openSync(`${LOGS}/electron.log`, "a", 0o600);
  const app = spawn("bash", ["-c", `while true; do ${launcher}; sleep 5; done`], { cwd: "/workspace", env, stdio: ["ignore", log, log], detached: true });
  closeSync(log);
  app.unref();
  stack.defer(() => { try { process.kill(-app.pid, "SIGTERM"); } catch { /* already exited */ } });
  const ready = (async () => {
    while (true) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
        if (Array.isArray(targets) && targets.some((target) => target.type === "page")) break;
      } catch { /* still booting */ }
      await delay(3_000);
    }
    status(await signIn(world, den) ? "ready" : "ready-signed-out");
    return true;
  })();
  return { url: `http://127.0.0.1:${NOVNC_PORT}`, denUrl: den.webUrl, ready };
}
