import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "appimage-desktop-integration";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const APPIMAGE = process.env.OPENWORK_EVAL_APPIMAGE_PATH;
const MOVED_APPIMAGE = process.env.OPENWORK_EVAL_MOVED_APPIMAGE_PATH;
const DATA_HOME = process.env.OPENWORK_EVAL_XDG_DATA_HOME;
const CONFIG_HOME = process.env.OPENWORK_EVAL_XDG_CONFIG_HOME;
const CACHE_HOME = process.env.OPENWORK_EVAL_XDG_CACHE_HOME;
const USER_DATA = process.env.OPENWORK_EVAL_ELECTRON_USERDATA;
const CDP_URL = process.env.OPENWORK_EVAL_CDP_URL ?? "http://127.0.0.1:9223";
const CDP_PORT = new URL(CDP_URL).port;
const DESKTOP_ID = "com.differentai.openwork.desktop";
const MANAGER_ID = "gearlever-openwork.desktop";
const MIME = "x-scheme-handler/openwork";

function xdgEnvironment() {
  return {
    ...process.env,
    XDG_DATA_HOME: DATA_HOME,
    XDG_CONFIG_HOME: CONFIG_HOME,
    XDG_CACHE_HOME: CACHE_HOME,
  };
}

function record(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: xdgEnvironment(),
    timeout: 30_000,
  });
}

async function desktopStatus(ctx) {
  return ctx.eval(
    `window.__OPENWORK_ELECTRON__.invokeDesktop("desktopIntegrationStatus")`,
    { awaitPromise: true },
  );
}

async function waitForIntegrationState(ctx, expected, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await desktopStatus(ctx);
    if (last?.state === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Desktop integration stayed at "${last?.state}" instead of "${expected}".`);
}

async function scrollIntegrationIntoView(ctx) {
  await ctx.eval(`(() => {
    const heading = [...document.querySelectorAll("h3")]
      .find((entry) => entry.textContent?.includes("AppImage desktop integration"));
    heading?.scrollIntoView({ block: "start" });
  })()`);
}

async function closeApp(ctx) {
  await ctx.eval("window.close()").catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP_URL}/json/list`);
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("OpenWork did not close before the AppImage relaunch.");
}

function launchAppImage(appImagePath) {
  const child = spawn(appImagePath, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...xdgEnvironment(),
      OPENWORK_ELECTRON_USERDATA: USER_DATA,
      OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: CDP_PORT,
    },
  });
  child.unref();
}

async function dismissPromptFor(appImagePath) {
  const statePath = path.join(CONFIG_HOME, "openwork", "desktop-integration.json");
  const raw = await readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  if (!state.dismissedAppImages.includes(appImagePath)) {
    state.dismissedAppImages.push(appImagePath);
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export default {
  id: FLOW_ID,
  title: "A raw AppImage integrates, repairs after a move, and defers to external managers",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_APPIMAGE_PATH",
    "OPENWORK_EVAL_MOVED_APPIMAGE_PATH",
    "OPENWORK_EVAL_XDG_DATA_HOME",
    "OPENWORK_EVAL_XDG_CONFIG_HOME",
    "OPENWORK_EVAL_XDG_CACHE_HOME",
    "OPENWORK_EVAL_ELECTRON_USERDATA",
    "OPENWORK_EVAL_CDP_URL",
  ],
  steps: [
    {
      name: "A raw AppImage offers explicit integration",
      run: async (ctx) => {
        await ctx.prove("The packaged AppImage shows an opt-in desktop integration control", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 45_000 });
            await ctx.navigateHash("/settings/preferences");
            await ctx.expectText("AppImage desktop integration", { timeoutMs: 30_000 });
            await scrollIntegrationIntoView(ctx);
          },
          assert: async () => {
            const status = await desktopStatus(ctx);
            record(ctx, status.supported === true, "The running artifact is recognized as a Linux AppImage");
            record(ctx, status.state === "not_integrated", "Desktop integration remains opt-in", status.state);
            await ctx.expectText("Not integrated");
            await ctx.expectText("Integrate");
          },
          screenshot: {
            name: "appimage-integration-opt-in",
            requireText: ["AppImage desktop integration", "Not integrated", "Integrate"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
    {
      name: "Integration creates a working GNOME launcher and callback",
      run: async (ctx) => {
        await ctx.prove("Integrate installs the launcher, icon, and openwork:// handler", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("Integrate", { selector: "button" });
            await ctx.waitForText("Integrated", { timeoutMs: 30_000 });
            await scrollIntegrationIntoView(ctx);
          },
          assert: async () => {
            const status = await desktopStatus(ctx);
            record(ctx, status.state === "integrated", "Settings reports a complete integration", status.state);

            const desktopPath = path.join(DATA_HOME, "applications", DESKTOP_ID);
            const desktopEntry = await readFile(desktopPath, "utf8");
            record(ctx, desktopEntry.includes(`Exec="${APPIMAGE}" %U`), "The launcher targets the current AppImage with a URL placeholder");
            record(ctx, desktopEntry.includes(`MimeType=${MIME};`), "The launcher advertises the browser callback scheme");
            const validation = run("desktop-file-validate", [desktopPath]);
            record(ctx, validation.status === 0, "The installed launcher passes the freedesktop validator", validation.stderr.trim());

            const handler = run("xdg-mime", ["query", "default", MIME]);
            record(ctx, handler.status === 0 && handler.stdout.trim() === DESKTOP_ID, "The OpenWork launcher is the selected openwork:// handler", handler.stdout.trim());

            const iconPath = path.join(DATA_HOME, "icons", "hicolor", "512x512", "apps", "com.differentai.openwork.png");
            const icon = run("file", [iconPath]);
            record(ctx, icon.status === 0 && icon.stdout.includes("512 x 512"), "The installed launcher has a 512×512 PNG icon", icon.stdout.trim());

            const launch = run("gtk-launch", ["com.differentai.openwork"]);
            record(ctx, launch.status === 0, "GNOME can launch the installed desktop entry", launch.stderr.trim());
            ctx.output("Installed desktop entry", desktopEntry.trim());
          },
          screenshot: {
            name: "appimage-integration-complete",
            requireText: ["AppImage desktop integration", "Integrated", "Repair", "Remove"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
    {
      name: "A moved AppImage self-heals and manager ownership stays singular",
      run: async (ctx) => {
        await ctx.prove("A moved AppImage silently repairs its owned entry, then defers to a manager-owned launcher without duplication", {
          voiceover: vo[2],
          action: async () => {
            await closeApp(ctx);
            await mkdir(path.dirname(MOVED_APPIMAGE), { recursive: true });
            await rename(APPIMAGE, MOVED_APPIMAGE);
            await dismissPromptFor(MOVED_APPIMAGE);
            launchAppImage(MOVED_APPIMAGE);
            await ctx.reconnect({ timeoutMs: 90_000 });
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 45_000 });
            // The launcher is stale after the move. OpenWork repairs the entry it
            // already owns without asking again.
            await waitForIntegrationState(ctx, "integrated");
            const repaired = await readFile(path.join(DATA_HOME, "applications", DESKTOP_ID), "utf8");
            record(
              ctx,
              repaired.includes(`Exec="${MOVED_APPIMAGE}" %U`),
              "The moved AppImage is repaired without prompting again",
            );
            await ctx.navigateHash("/settings/preferences");
            await ctx.waitForText("Integrated", { timeoutMs: 30_000 });

            await ctx.clickText("Remove", { selector: "button" });
            await ctx.waitForText("Not integrated", { timeoutMs: 30_000 });
            await closeApp(ctx);

            const managerPath = path.join(DATA_HOME, "applications", MANAGER_ID);
            const managerEntry = `[Desktop Entry]
Type=Application
Name=OpenWork
Exec="${MOVED_APPIMAGE}" %U
TryExec=${MOVED_APPIMAGE}
Icon=com.differentai.openwork
Terminal=false
MimeType=${MIME};
`;
            await writeFile(managerPath, managerEntry);
            const handler = run("xdg-mime", ["default", MANAGER_ID, MIME]);
            if (handler.status !== 0) throw new Error(handler.stderr || "Could not select the manager launcher.");

            launchAppImage(MOVED_APPIMAGE);
            await ctx.reconnect({ timeoutMs: 90_000 });
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 45_000 });
            await ctx.navigateHash("/settings/preferences");
            await ctx.waitForText("Managed by another app", { timeoutMs: 30_000 });
            await scrollIntegrationIntoView(ctx);
          },
          assert: async () => {
            const status = await desktopStatus(ctx);
            record(ctx, status.state === "managed_externally", "OpenWork recognizes the manager-owned launcher", status.state);
            record(ctx, status.desktopEntryPath.endsWith(MANAGER_ID), "Status identifies the manager launcher", status.desktopEntryPath);
            const ownEntryExists = await access(path.join(DATA_HOME, "applications", DESKTOP_ID)).then(() => true, () => false);
            record(ctx, !ownEntryExists, "OpenWork does not create a duplicate launcher");
            const managerEntry = await readFile(path.join(DATA_HOME, "applications", MANAGER_ID), "utf8");
            record(ctx, managerEntry.includes(`Exec="${MOVED_APPIMAGE}" %U`), "The manager-owned launcher remains unchanged");
          },
          screenshot: {
            name: "appimage-manager-owned",
            requireText: ["AppImage desktop integration", "Managed by another app", "Recheck"],
            rejectText: ["Remove", "Use manager launcher"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
    {
      name: "Close the isolated proof app",
      run: async (ctx) => {
        await closeApp(ctx);
      },
    },
  ],
};
