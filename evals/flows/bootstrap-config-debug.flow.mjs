import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "bootstrap-config-debug";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const INITIAL_BASE_URL = "https://app.openworklabs.com";
const SAVED_BASE_URL = "https://bootstrap-debug.example.test";
const SAVED_ORG_SERVER_TEXT = `Current organization server: ${SAVED_BASE_URL}`;
const DEFAULT_ORG_SERVER_TEXT = "Using standard OpenWork Cloud.";

function bootstrapPath(ctx) {
  const rawPath = ctx.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim();
  ctx.assert(Boolean(rawPath), "OPENWORK_DESKTOP_BOOTSTRAP_PATH must be set so this flow never touches the real user config.");

  const resolvedPath = resolve(rawPath);
  const home = os.homedir();
  const unsafePrefixes = [
    resolve(home, ".config", "openwork"),
    resolve(home, "Library"),
  ];
  const unsafe = unsafePrefixes.some((prefix) => resolvedPath === prefix || resolvedPath.startsWith(`${prefix}/`));
  ctx.assert(!unsafe, `Refusing to use a real user config path: ${resolvedPath}`);
  return resolvedPath;
}

async function seedBootstrapFile(ctx) {
  const targetPath = bootstrapPath(ctx);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    `${JSON.stringify({
      baseUrl: INITIAL_BASE_URL,
      apiBaseUrl: `${INITIAL_BASE_URL}/api/den`,
      requireSignin: false,
      writtenAt: "2026-01-01T00:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
  return targetPath;
}

async function readBootstrapFile(ctx) {
  const raw = await readFile(bootstrapPath(ctx), "utf8");
  return JSON.parse(raw);
}

async function bootstrapFileExists(ctx) {
  try {
    await readFile(bootstrapPath(ctx), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function reloadCleanSettingsShell(ctx) {
  await ctx.eval(`(() => {
    localStorage.removeItem("openwork.developerMode");
    localStorage.removeItem("openwork.den.baseUrl");
    localStorage.removeItem("openwork.den.apiBaseUrl");
    localStorage.removeItem("openwork.den.authToken");
    localStorage.removeItem("openwork.den.activeOrgId");
    localStorage.removeItem("openwork.den.activeOrgSlug");
    localStorage.removeItem("openwork.den.activeOrgName");
    window.location.hash = "#/settings/advanced";
    location.reload();
    return true;
  })()`);
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "control API after reset reload",
  });
  await ctx.waitForText("Advanced", { timeoutMs: 30_000 });
}

async function enableDeveloperMode(ctx) {
  await ctx.waitForText("Developer mode", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const toggle = document.querySelector('[role="switch"][aria-label="Developer mode"]');
    if (!toggle) return false;
    toggle.scrollIntoView({ block: "center" });
    if (toggle.getAttribute("aria-checked") !== "true") {
      toggle.click();
    }
    return true;
  })()`);
  await ctx.waitFor(`localStorage.getItem("openwork.developerMode") === "1"`, {
    timeoutMs: 10_000,
    label: "developer mode enabled",
  });
  await ctx.waitForText("Debug", { timeoutMs: 10_000 });
}

async function bootstrapDebugText(ctx, requiredText) {
  const required = JSON.stringify(requiredText);
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return ${required}.every((entry) => text.includes(entry));
  })()`, {
    timeoutMs: 30_000,
    label: `bootstrap diagnostics ${requiredText.join(", ")}`,
  });
  return ctx.eval("document.body.innerText");
}

export default {
  id: FLOW_ID,
  title: "Bootstrap config diagnostics expose the desktop file and stamped URL saves",
  kind: "user-facing",
  steps: [
    {
      name: "App boots with an isolated bootstrap file",
      run: async (ctx) => {
        const targetPath = await seedBootstrapFile(ctx);
        ctx.log(`Using isolated bootstrap config: ${targetPath}`);
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "window.__openworkControl",
        });
        await reloadCleanSettingsShell(ctx);
      },
    },
    {
      name: "Developer mode exposes Debug settings",
      run: async (ctx) => {
        await ctx.prove("Developer mode can be enabled from Advanced settings", {
          voiceover: vo[0],
          action: async () => {
            await ctx.navigateHash("/settings/advanced");
            await enableDeveloperMode(ctx);
          },
          assert: async () => {
            await ctx.expectText("Developer mode");
            await ctx.expectText("Debug");
          },
          screenshot: {
            name: "advanced-developer-mode-enabled",
            requireText: ["Developer mode", "Debug"],
            hashIncludes: "/settings/advanced",
          },
        });
      },
    },
    {
      name: "Debug shows bootstrap diagnostics",
      run: async (ctx) => {
        await ctx.prove("Debug renders the Bootstrap config diagnostics", {
          voiceover: vo[1],
          action: async () => {
            await ctx.navigateHash("/settings/debug");
            await bootstrapDebugText(ctx, ["Bootstrap config", "baseUrl", INITIAL_BASE_URL]);
          },
          assert: async () => {
            const text = await bootstrapDebugText(ctx, ["Bootstrap config", "path", "normalized", INITIAL_BASE_URL]);
            ctx.assert(text.includes(bootstrapPath(ctx)), "Debug diagnostics did not show the isolated bootstrap path.");
          },
          screenshot: {
            name: "debug-bootstrap-config",
            requireText: ["Bootstrap config", "baseUrl"],
            hashIncludes: "/settings/debug",
          },
        });
      },
    },
    {
      name: "Organization server URL save is persisted with writtenAt",
      run: async (ctx) => {
        await ctx.prove("Saving an organization server URL updates Advanced settings and writes a stamped bootstrap file", {
          voiceover: vo[2],
          action: async () => {
            await ctx.navigateHash("/settings/advanced");
            await ctx.waitForText("Organization server URL", { timeoutMs: 30_000 });
            await ctx.fill("label input", SAVED_BASE_URL);
            await ctx.clickText("Save", { selector: "button" });
            await ctx.waitForText(SAVED_ORG_SERVER_TEXT, { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.expectText(SAVED_ORG_SERVER_TEXT);
            const persisted = await readBootstrapFile(ctx);
            ctx.assert(persisted.baseUrl === SAVED_BASE_URL, `Expected persisted baseUrl ${SAVED_BASE_URL}, got ${persisted.baseUrl}`);
            ctx.assert(typeof persisted.writtenAt === "string" && Number.isFinite(Date.parse(persisted.writtenAt)), "Persisted bootstrap config is missing a valid writtenAt timestamp.");
            ctx.log(`Bootstrap file witness: ${JSON.stringify({ baseUrl: persisted.baseUrl, writtenAt: persisted.writtenAt })}`);
          },
          screenshot: {
            name: "advanced-org-server-url-save-confirmed",
            requireText: ["Organization server URL", SAVED_ORG_SERVER_TEXT],
            hashIncludes: "/settings/advanced",
          },
        });
      },
    },
    {
      name: "Debug shows the saved stamped bootstrap config",
      run: async (ctx) => {
        await ctx.prove("Debug diagnostics show the saved URL and writtenAt stamp after reload", {
          voiceover: vo[3],
          action: async () => {
            await ctx.navigateHash("/settings/debug");
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 30_000,
              label: "control API after debug reload",
            });
            await bootstrapDebugText(ctx, ["Bootstrap config", SAVED_BASE_URL, "writtenAt"]);
          },
          assert: async () => {
            const text = await bootstrapDebugText(ctx, ["Bootstrap config", SAVED_BASE_URL, "writtenAt"]);
            const persisted = await readBootstrapFile(ctx);
            ctx.assert(text.includes(persisted.writtenAt), "Debug diagnostics did not show the persisted writtenAt timestamp.");
          },
          screenshot: {
            name: "debug-bootstrap-saved-stamp",
            requireText: ["Bootstrap config", SAVED_BASE_URL, "writtenAt"],
            hashIncludes: "/settings/debug",
          },
        });
      },
    },
    {
      name: "Organization server configuration can be cleared",
      run: async (ctx) => {
        await ctx.prove("Clearing the desktop server configuration returns the app to the default control plane", {
          voiceover: vo[4],
          action: async () => {
            await ctx.navigateHash("/settings/advanced");
            await ctx.waitForText("Clear server configuration", { timeoutMs: 30_000 });
            await ctx.clickText("Clear server configuration", { selector: "button" });
            await ctx.waitForText("Click again to clear", { timeoutMs: 10_000 });
            await ctx.clickText("Click again to clear", { selector: "button" });
            await ctx.waitForText(DEFAULT_ORG_SERVER_TEXT, { timeoutMs: 15_000 });
            await ctx.waitFor(`(() => {
              const input = Array.from(document.querySelectorAll("label")).find((node) => (node.textContent ?? "").includes("Organization server URL"))?.querySelector("input");
              return input?.value === "" && input?.placeholder === ${JSON.stringify(INITIAL_BASE_URL)};
            })()`, {
              timeoutMs: 10_000,
              label: "default organization server placeholder restored",
            });
          },
          assert: async () => {
            await ctx.expectText(DEFAULT_ORG_SERVER_TEXT);
            const inputValue = await ctx.eval(`(() => {
              const input = Array.from(document.querySelectorAll("label")).find((node) => (node.textContent ?? "").includes("Organization server URL"))?.querySelector("input");
              return input?.value ?? "";
            })()`);
            ctx.assert(inputValue === "", `Expected the default URL to render as an empty custom URL field, got ${inputValue}`);
            ctx.assert(!(await bootstrapFileExists(ctx)), "Expected the isolated canonical bootstrap file to be removed.");
            // With OPENWORK_DESKTOP_BOOTSTRAP_PATH set, the desktop code disables the legacy path
            // instead of resolving the real user's ~/.config path. Unit coverage asserts legacy removal.
            ctx.log("Bootstrap file witness: isolated canonical file removed; legacy path is disabled under OPENWORK_DESKTOP_BOOTSTRAP_PATH.");
          },
          screenshot: {
            name: "advanced-org-server-url-clear-confirmed",
            requireText: ["Organization server URL", "Clear server configuration", DEFAULT_ORG_SERVER_TEXT],
            hashIncludes: "/settings/advanced",
          },
        });
      },
    },
  ],
};
