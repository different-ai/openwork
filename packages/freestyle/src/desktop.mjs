import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// Controller-owned: a virtual display, a VNC server bound to loopback, and the
// noVNC web client, all behind the preview gateway's own access check. The
// OpenWork desktop app itself comes from the reviewed commit in /workspace.
const DESKTOP_DISPLAY = ":99";
const NOVNC_PORT = 6080;
const VNC_PORT = 5900;
const CDP_PORT = 9825;
const LOGS = "/opt/openwork-preview/desktop";

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

// Signs the running window in as the demo owner with the harness's own handoff,
// over the launcher's debug port. Any failure leaves the real app signed out.
async function signIn(world) {
  try {
    // The handoff goes through Den web's /api/den proxy; compile that route first.
    await fetch(`${world.den.ref.webUrl}/api/den/health`, { signal: AbortSignal.timeout(120_000) }).catch(() => undefined);
    const { attachSurface } = await import("/workspace/evals/packages/cdp/src/index.ts");
    const { signInDesktopAs } = await import("/workspace/evals/packages/behaviors/src/index.ts");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const surface = await attachSurface({ name: "preview-desktop", kind: "electron", hostKind: "local", cdpUrl: `http://127.0.0.1:${CDP_PORT}` }, { timeoutMs: 60_000 });
      try { await signInDesktopAs(surface, world.den.ref, world.den.admin); return true; }
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
  service(stack, "fluxbox", [], "fluxbox");
  service(stack, "x11vnc", ["-display", DESKTOP_DISPLAY, "-localhost", "-rfbport", String(VNC_PORT), "-forever", "-shared", "-nopw", "-quiet"], "x11vnc");
  service(stack, "websockify", ["--web", "/usr/share/novnc", `127.0.0.1:${NOVNC_PORT}`, `127.0.0.1:${VNC_PORT}`], "novnc");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${NOVNC_PORT}/vnc.html`, { signal: AbortSignal.timeout(2_000) })).ok, "viewer");
  const status = (value) => writeFileSync(`${LOGS}/status`, value, { mode: 0o600 });
  status("starting");
  // Upstream's Linux desktop launcher (used by Daytona previews) runs the real
  // app from the reviewed commit. A relaunch loop and a deadline-free readiness
  // poll keep it working across the snapshot's pause and resume.
  writeFileSync(`${LOGS}/bootstrap.json`, JSON.stringify({ baseUrl: world.den.ref.webUrl, requireSignin: false }), { mode: 0o600 });
  const env = {
    ...process.env, DISPLAY: DESKTOP_DISPLAY, OPENWORK_WORKSPACE_DIR: "/workspace", PORT: "5186",
    OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: String(CDP_PORT), OPENWORK_DESKTOP_BOOTSTRAP_PATH: `${LOGS}/bootstrap.json`,
    OPENWORK_ELECTRON_USERDATA: "/root/.openwork-desktop", OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
    OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    // The snapshot builder already fetched the sidecars and helpers.
    OPENWORK_ELECTRON_SKIP_SHARED_PREPARE: "1",
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
    status(await signIn(world) ? "ready" : "ready-signed-out");
    return true;
  })();
  return { url: `http://127.0.0.1:${NOVNC_PORT}`, ready };
}
