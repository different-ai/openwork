import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundledCli = fileURLToPath(new URL("../server/dist/cli.js", import.meta.url));

/** Keep executable dispatch separate from the GUI's imports and lifecycle. */
export function dispatchDesktopEntry({
  app,
  loadGui,
  defaultApp = false,
  argv = process.argv,
  ...dependencies
}) {
  const args = argv.slice(defaultApp ? 2 : 1);
  if (args[0] !== "login") return loadGui();
  return runLoginCommand({ ...dependencies, app, args: args.slice(1) });
}

/** The existing server CLI owns argument validation, custody and all auth guards. */
export function runLoginCommand({
  app,
  args,
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  signals = process,
  spawnChild = spawn,
  createProfile = () => mkdtempSync(join(tmpdir(), "openwork-login-")),
  removeProfile = (directory) => rmSync(directory, { recursive: true, force: true }),
  writeError = (message) => console.error(message),
}) {
  let profile;
  let finished = false;
  let child;
  let interrupted = false;
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTerminate = () => forward("SIGTERM");
  function forward(signal) {
    // One cancellation is enough; the CLI needs time to clean up its pending
    // request. A detached POSIX child does not also receive the terminal's
    // foreground-group interrupt, avoiding a second, default-fatal signal.
    if (interrupted || finished) return;
    interrupted = true;
    child?.kill(signal);
  }
  function finish(code) {
    if (finished) return;
    finished = true;
    signals.removeListener("SIGINT", forwardInterrupt);
    signals.removeListener("SIGTERM", forwardTerminate);
    signals.removeListener("SIGHUP", forwardTerminate);
    if (profile) {
      try { removeProfile(profile); } catch { /* Never expose filesystem details. */ }
    }
    app.exit(code);
  }

  try {
    // Electron owns only this short-lived parent. Configure it before app
    // readiness; the child's real HOME/discovery environment stays untouched.
    if (platform === "linux") {
      app.commandLine.appendSwitch("ozone-platform", "headless");
      if (env.ELECTRON_DISABLE_SANDBOX === "1") app.commandLine.appendSwitch("no-sandbox");
      app.disableHardwareAcceleration();
    }
    if (platform === "darwin") app.setActivationPolicy("prohibited");
    profile = createProfile();
    app.setPath("userData", profile);
    app.setPath("sessionData", profile);
    app.setPath("crashDumps", profile);
    app.setAppLogsPath(profile);
    child = spawnChild(execPath, [bundledCli, "login", ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
      detached: platform !== "win32",
      windowsHide: true,
    });
    signals.on("SIGINT", forwardInterrupt);
    signals.on("SIGTERM", forwardTerminate);
    // An SSH disconnect must cancel the detached child rather than orphan it.
    if (platform !== "win32") signals.on("SIGHUP", forwardTerminate);
    child.once("error", () => {
      writeError("Device sign-in could not start. Use the sign-in link instead.");
      finish(1);
    });
    child.once("close", (code, signal) => {
      finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  } catch {
    writeError("Device sign-in could not start. Use the sign-in link instead.");
    finish(1);
  }
}
