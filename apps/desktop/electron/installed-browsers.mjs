import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Deliberately a catalog, not universal application enumeration. Only these
// stable browser installations are supported (Safari and Arc are macOS-only).
// No registry command strings, desktop Exec fields, profiles, or history are read.
const BROWSERS = [
  { id: "safari", name: "Safari", mac: ["Safari.app", "Safari"] },
  {
    id: "chrome", name: "Google Chrome",
    mac: ["Google Chrome.app", "Google Chrome"],
    win: "Google/Chrome/Application/chrome.exe",
    linux: ["google-chrome", "google-chrome-stable"],
  },
  {
    id: "firefox", name: "Firefox",
    mac: ["Firefox.app", "firefox"],
    win: "Mozilla Firefox/firefox.exe",
    linux: ["firefox", "firefox-esr"],
  },
  {
    id: "edge", name: "Microsoft Edge",
    mac: ["Microsoft Edge.app", "Microsoft Edge"],
    win: "Microsoft/Edge/Application/msedge.exe",
    linux: ["microsoft-edge", "microsoft-edge-stable"],
  },
  {
    id: "brave", name: "Brave",
    mac: ["Brave Browser.app", "Brave Browser"],
    win: "BraveSoftware/Brave-Browser/Application/brave.exe",
    linux: ["brave-browser", "brave"],
  },
  { id: "arc", name: "Arc", mac: ["Arc.app", "Arc"] },
  {
    id: "chromium", name: "Chromium",
    mac: ["Chromium.app", "Chromium"],
    win: "Chromium/Application/chrome.exe",
    linux: ["chromium", "chromium-browser"],
  },
  {
    id: "vivaldi", name: "Vivaldi",
    mac: ["Vivaldi.app", "Vivaldi"],
    win: "Vivaldi/Application/vivaldi.exe",
    linux: ["vivaldi", "vivaldi-stable"],
  },
  {
    id: "opera", name: "Opera",
    mac: ["Opera.app", "Opera"],
    win: "Opera/launcher.exe",
    linux: ["opera"],
  },
];

// Reject raw and percent-encoded controls without rejecting UTF-8 continuation
// bytes in otherwise ordinary encoded URLs.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%[89][0-9a-f]/i;

async function isFile(file, mode) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

function launchBrowser(name, executable, args, waitForExit) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    function finish(failed) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.unref();
      // Never propagate child-process errors containing the URL or output.
      if (failed) reject(new Error(`Could not launch ${name}.`));
      else resolve();
    }

    try {
      child = spawn(executable, args, {
        shell: false,
        detached: !waitForExit,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(true);
      return;
    }

    timer = setTimeout(() => {
      finish(true);
      if (waitForExit) {
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      }
    }, 5_000);
    child.once("error", () => finish(true));
    child.once("exit", (code) => finish(code !== 0));
    child.once("spawn", () => {
      if (waitForExit || settled) return;
      clearTimeout(timer);
      // A browser can live indefinitely. Observe early startup failures, then
      // acknowledge startup, not page load or the browser's eventual exit.
      timer = setTimeout(() => finish(false), 1_500);
    });
  });
}

/**
 * Main-process-only descriptors: retain this list for one menu and expose only
 * id/name to the renderer. Executable paths stay captured here, never in IPC.
 *
 * macOS: /Applications, ~/Applications, /System/Applications; require the known
 * bundle executable and Info.plist. Relocated/renamed bundles are not enumerated.
 * Windows: ProgramW6432, ProgramFiles, ProgramFiles(x86), LOCALAPPDATA and its
 * Programs subdirectory, using only the relative .exe paths in BROWSERS.
 * Linux: the catalog's executable names in the first 64 distinct absolute PATH
 * directories; skip empty/relative entries. Symlinks and executable wrappers
 * work; Flatpak-only registrations, arbitrary desktop files and other browsers
 * are not enumerated. Unsupported platforms return an empty list.
 *
 * Discovery has a two-second budget and returns any completed matches in catalog
 * order. It never executes a browser or a discovery command.
 * @returns {Promise<Array<{ id: string, name: string, open: (url: string) => Promise<void> }>>}
 */
export async function listInstalledBrowsers() {
  if (process.type && process.type !== "browser") {
    throw new Error("Installed browser discovery is main-process-only.");
  }

  const platform = process.platform;
  let roots;
  if (platform === "darwin") {
    roots = ["/Applications", path.join(homedir(), "Applications"), "/System/Applications"];
  } else if (platform === "win32") {
    roots = [
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    ];
  } else if (platform === "linux") {
    roots = (process.env.PATH ?? "").split(path.delimiter);
  } else {
    return [];
  }
  roots = [...new Set(roots.filter((root) => typeof root === "string" && path.isAbsolute(root)))].slice(0, 64);

  const found = new Map();
  let expired = false;
  let timer;
  try {
    await Promise.race([
      Promise.all(BROWSERS.map(async (browser) => {
        const names = platform === "darwin"
          ? [path.join(browser.mac[0], "Contents", "MacOS", browser.mac[1])]
          : platform === "win32"
            ? (browser.win ? [browser.win] : [])
            : (browser.linux ?? []);
        for (const root of roots) {
          for (const name of names) {
            if (expired) return;
            const executable = path.join(root, name);
            if (!await isFile(executable, platform === "win32" ? constants.F_OK : constants.X_OK)) continue;
            const application = platform === "darwin" ? path.join(root, browser.mac[0]) : null;
            if (application && !await isFile(path.join(application, "Contents", "Info.plist"), constants.R_OK)) continue;
            if (expired) return;

            found.set(browser.id, {
              id: browser.id,
              name: browser.name,
              async open(url) {
                let target;
                try {
                  if (typeof url !== "string" || url !== url.trim() || !/^https?:\/\//i.test(url)
                    || url.includes("\\") || CONTROL_CHARACTERS.test(url)) throw new Error();
                  target = new URL(url);
                  if (!target.hostname || target.username || target.password
                    || !["http:", "https:"].includes(target.protocol)
                    || url.slice(url.indexOf("://") + 3).split(/[/?#]/, 1)[0].includes("@")) throw new Error();
                } catch {
                  throw new Error("Expected an HTTP(S) URL without credentials or control characters.");
                }
                await launchBrowser(
                  browser.name,
                  application ? "/usr/bin/open" : executable,
                  application ? ["-a", application, target.href] : [target.href],
                  application !== null,
                );
              },
            });
            return;
          }
        }
      })),
      new Promise((resolve) => {
        timer = setTimeout(() => { expired = true; resolve(); }, 2_000);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
  return BROWSERS.flatMap(({ id }) => found.has(id) ? [found.get(id)] : []);
}
