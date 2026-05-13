// External-terminal launcher for OpenEral sessions. Until the xterm.js
// renderer view lands (deferred pending founder review of the session
// UX shape), the only way to interact with a freshly-created OpenEral
// sandbox is to spawn an OS terminal window that runs
// `wsl -d openwork-openshell -- openshell sandbox connect <name>`.
//
// Platforms:
//   - Windows: Windows Terminal (wt.exe) if available, else cmd.exe.
//     Windows Terminal handles TTY resize properly; cmd.exe is the
//     fallback so the feature works on stock Windows 11 install.
//   - macOS:   osascript drives Terminal.app to open a new window.
//   - Linux:   probes a list of known terminal emulators and uses the
//              first one found. Dev-only — banker laptops are Windows.

import { spawn } from "node:child_process";
import process from "node:process";

import { DISTRO_NAME } from "./wsl.mjs";

const LINUX_TERMINAL_CANDIDATES = [
  // Each entry is { command, argsForCommand(cmd, args) → string[] }
  // where the inner closure builds the argv that launches `cmd args[...]`
  // inside the terminal emulator and exits when it does.
  { exe: "alacritty", build: (cmd, args) => ["-e", cmd, ...args] },
  { exe: "kitty", build: (cmd, args) => [cmd, ...args] },
  { exe: "wezterm", build: (cmd, args) => ["start", "--", cmd, ...args] },
  { exe: "gnome-terminal", build: (cmd, args) => ["--", cmd, ...args] },
  { exe: "konsole", build: (cmd, args) => ["-e", cmd, ...args] },
  { exe: "xfce4-terminal", build: (cmd, args) => ["-e", `${cmd} ${args.join(" ")}`] },
  { exe: "tilix", build: (cmd, args) => ["-e", `${cmd} ${args.join(" ")}`] },
  { exe: "xterm", build: (cmd, args) => ["-e", cmd, ...args] },
];

function detectLinuxTerminal() {
  for (const candidate of LINUX_TERMINAL_CANDIDATES) {
    try {
      // Cheap probe: spawn `which`. Cross-distro available.
      const probe = spawn("which", [candidate.exe], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      // Synchronous wait via a small busy promise wouldn't fit here.
      // Instead, return the first candidate that doesn't error
      // immediately — `which` returning non-zero is handled at launch
      // time by the actual spawn() failing. This is good enough for the
      // Linux dev path; bankers run Windows.
      probe.unref();
    } catch {
      // ignore
    }
  }
  // Without a synchronous which-check, return them all and let the
  // caller try in order. Cleaner: the actual launcher tries each.
  return LINUX_TERMINAL_CANDIDATES;
}

/**
 * Spawn an OS terminal window running `wsl -d <distro> -- openshell
 * sandbox connect <name>`. Returns once the terminal launch has been
 * dispatched — does NOT wait for the user to close it.
 *
 * Throws if no terminal could be launched.
 *
 * @param {string} sandboxName
 * @param {{ windowTitle?: string }} [options]
 */
export async function launchExternalTerminalToSandbox(sandboxName, options = {}) {
  if (!sandboxName) throw new Error("launchExternalTerminalToSandbox: sandboxName is required");
  const windowTitle = options.windowTitle ?? `OpenWork — ${sandboxName}`;

  if (process.platform === "win32") {
    return launchWindowsTerminal(sandboxName, windowTitle);
  }
  if (process.platform === "darwin") {
    return launchMacOSTerminal(sandboxName, windowTitle);
  }
  return launchLinuxTerminal(sandboxName, windowTitle);
}

function launchWindowsTerminal(sandboxName, windowTitle) {
  // Try Windows Terminal first. The `wt.exe` shim accepts `--title`
  // and runs `wsl.exe -d ... -- openshell sandbox connect <name>`
  // directly as the command. If wt isn't installed (older Win11
  // installs), fall back to cmd.exe /K so the window stays open after
  // the connect command exits.
  const wslArgs = ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "connect", sandboxName];

  const wtChild = spawn(
    "wt.exe",
    ["--title", windowTitle, "wsl.exe", ...wslArgs],
    { detached: true, stdio: "ignore", windowsHide: false },
  );
  return new Promise((resolve, reject) => {
    wtChild.once("error", () => {
      // wt.exe missing — fall back to cmd.exe.
      const cmdChild = spawn(
        "cmd.exe",
        ["/C", "start", `"${windowTitle}"`, "wsl.exe", ...wslArgs],
        { detached: true, stdio: "ignore", windowsHide: false, shell: true },
      );
      cmdChild.once("error", reject);
      cmdChild.unref();
      resolve({ launched: "cmd.exe" });
    });
    wtChild.unref();
    // Resolve a tick after dispatch — wt.exe's "error" fires sync if missing.
    setTimeout(() => resolve({ launched: "wt.exe" }), 50);
  });
}

function launchMacOSTerminal(sandboxName, windowTitle) {
  // osascript opens Terminal.app and runs a command. We can't directly
  // run wsl on macOS (it doesn't exist) but the sandbox-connect target
  // is wsl-resident, so this path is dev-only and runs against a
  // remote dev distro via SSH (which a banker laptop wouldn't have).
  // Surfacing a clear "macOS unsupported for OpenEral" error is more
  // honest than spawning a terminal that immediately fails.
  return Promise.reject(
    new Error(
      "OpenEral sessions are not supported on macOS — the openwork-openshell WSL distro " +
        "only exists on Windows. macOS / Linux remain testing-only host platforms for " +
        "OpenWork itself; the sandboxes always run on the banker's Windows machine.",
    ),
  );
}

async function launchLinuxTerminal(sandboxName, windowTitle) {
  // Linux is dev convenience only — banker laptops are Windows. Probe a
  // list of common terminal emulators in priority order.
  const wslArgs = ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "connect", sandboxName];
  const candidates = detectLinuxTerminal();
  for (const cand of candidates) {
    const args = cand.build("wsl.exe", wslArgs);
    try {
      const child = spawn(cand.exe, args, {
        detached: true,
        stdio: "ignore",
      });
      // Sync error from missing binary fires within a tick.
      const launched = await new Promise((resolve) => {
        let settled = false;
        child.once("error", () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.unref();
            resolve(true);
          }
        }, 80);
      });
      if (launched) {
        return { launched: cand.exe };
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not find a terminal emulator to launch the OpenEral session in. " +
      "Install one of: alacritty, kitty, wezterm, gnome-terminal, konsole, xfce4-terminal, tilix, xterm. " +
      "(Linux is a dev-only host for OpenEral; banker laptops run Windows.)",
  );
}

/**
 * Sanitize a workspace id into a stable OpenShell sandbox name.
 * Sandbox name = workspace id is OpenEral's portability story; same
 * workspace from a different machine restores the same Postgres-backed
 * /home/agent. We just guard against punctuation OpenShell won't accept.
 */
export function deriveOpenEralSandboxName(workspaceId) {
  const trimmed = String(workspaceId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  if (!trimmed) {
    throw new Error("Cannot derive OpenEral sandbox name from empty workspace id.");
  }
  return `openeral-${trimmed}`;
}
