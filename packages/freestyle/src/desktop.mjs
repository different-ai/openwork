import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// Controller-owned: a virtual display, a VNC server bound to loopback, and the
// noVNC web client, all behind the preview gateway's own access check. The
// OpenWork desktop app itself comes from the reviewed commit in /workspace.
export const DESKTOP_DISPLAY = ":99";
export const NOVNC_PORT = 6080;
const VNC_PORT = 5900;
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

/**
 * Starts the display and viewer (seconds), then boots the real desktop app (signed out) in
 * the background so the world's existing readiness and build timing are unchanged.
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
  // Same launch path as Linux CI desktop proofs: Chromium's SUID sandbox is
  // unavailable to the guest's root services, so container mode passes --no-sandbox.
  process.env.DISPLAY = DESKTOP_DISPLAY;
  process.env.OPENWORK_EVAL_CONTAINER_ELECTRON = "1";
  // The snapshot builder already fetched the sidecars and helpers.
  process.env.OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED = "1";
  void (async () => {
    const { app } = await import("/workspace/evals/packages/env/src/desktop-app.ts");
    const { resolvePlace } = await import("/workspace/evals/packages/env/src/place.ts");
    // Signed out: the snapshot's Den answers on internal template origins that the
    // in-VM desktop cannot reach yet. The app itself, its workspace and UI are real.
    // A cold first boot compiles on demand; the retry reuses those warm caches.
    for (let attempt = 1; ; attempt++) {
      try {
        stack.use(await app({ den: world.den, place: resolvePlace(), signIn: false, workspacePath: "/root/openwork-desktop" }));
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        console.error("Desktop app first boot timed out; retrying with warm caches:", error);
      }
    }
    status("ready");
  })().catch((error) => {
    console.error("Desktop app did not start:", error);
    status("failed");
  });
  return { url: `http://127.0.0.1:${NOVNC_PORT}` };
}
