import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "runtime-config-ownership";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const CARD_TITLE = "Runtime config ownership";
const CARD_RULE = "OpenWork writes only the managed runtime config file; user OpenCode config stays user-owned.";
const REDACTED_CONTENT_LABEL = "Redacted managed file";
const REDACTED_CONTENT_VISIBLE_LABEL = "REDACTED MANAGED FILE";
const DISABLED_PROVIDER = "anthropic";
const LEGACY_HEADER = "// Personal OpenCode config owned by me.\n";
const LEGACY_CONTENT = `${LEGACY_HEADER}{
  "mcp": {
    "openwork-cloud": {
      "type": "remote",
      "url": "https://stale-cloud.example.test/mcp",
      "headers": {
        "Authorization": "Bearer stale-legacy-token"
      }
    },
    "my-notion": {
      "type": "remote",
      "url": "https://notion.example.test/mcp"
    }
  },
  "agent": {
    "openwork": {
      "description": "Legacy OpenWork agent left by an older build",
      "mode": "primary"
    }
  },
  "default_agent": "openwork",
  "plugin": [
    "./plugins/my-plugin.js",
    "/Users/example/.local/share/opencode-plugins/openwork-extensions-preview/index.js"
  ]
}
`;

function devDataRoot() {
  const appIdentifier = "com.differentai.openwork.dev";
  if (process.platform === "darwin") {
    return resolve(os.homedir(), "Library", "Application Support", appIdentifier, "openwork-dev-data");
  }
  if (process.platform === "win32") {
    const appDataRoot = process.env.APPDATA?.trim() || join(os.homedir(), "AppData", "Roaming");
    return resolve(appDataRoot, appIdentifier, "openwork-dev-data");
  }
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(os.homedir(), ".config");
  return resolve(configRoot, appIdentifier, "openwork-dev-data");
}

function assertDevDataPath(ctx, path) {
  const root = devDataRoot();
  const resolved = resolve(path);
  ctx.assert(
    resolved === root || resolved.startsWith(`${root}${sep}`),
    `Refusing to touch a path outside openwork-dev-data: ${resolved}`,
  );
  ctx.assert(resolved.includes("openwork-dev-data"), `Resolved path is not under openwork-dev-data: ${resolved}`);
  return resolved;
}

function legacyConfigPath(ctx) {
  return assertDevDataPath(ctx, join(devDataRoot(), "home", ".config", "opencode", "opencode.jsonc"));
}

function runtimeStorageCandidates(ctx) {
  return [
    join(devDataRoot(), "home", ".config", "openwork"),
    join(devDataRoot(), "xdg", "config", "openwork"),
  ].map((path) => assertDevDataPath(ctx, path));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForNode(ctx, label, probe, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function getServerInfo(ctx) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
  const info = await ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo')", {
    awaitPromise: true,
  });
  const baseUrl = String(info?.baseUrl || info?.connectUrl || "").replace(/\/+$/, "");
  const token = String(info?.ownerToken || info?.clientToken || "").trim();
  const hostToken = String(info?.hostToken || "").trim();
  ctx.assert(Boolean(baseUrl), "OpenWork server base URL is unavailable.");
  ctx.assert(Boolean(token), "OpenWork server token is unavailable.");
  return { baseUrl, token, hostToken };
}

async function fetchOpenworkJson(ctx, path, options = {}) {
  const info = await getServerInfo(ctx);
  const headers = {
    Authorization: `Bearer ${info.token}`,
    ...(info.hostToken ? { "X-OpenWork-Host-Token": info.hostToken } : {}),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
  };
  const response = await fetch(`${info.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function workspaceItems(payload) {
  return Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.workspaces)
      ? payload.workspaces
      : [];
}

async function ensureWorkspace(ctx) {
  if (ctx.runtimeConfigOwnership?.workspaceId) return ctx.runtimeConfigOwnership;

  const workspaceDir = assertDevDataPath(ctx, join(devDataRoot(), "eval-workspaces", FLOW_ID));
  await mkdir(workspaceDir, { recursive: true });

  let list = await fetchOpenworkJson(ctx, "/workspaces");
  let workspace = workspaceItems(list).find((item) => resolve(String(item?.path ?? "")) === workspaceDir);
  if (!workspace) {
    const created = await fetchOpenworkJson(ctx, "/workspaces/local", {
      method: "POST",
      body: {
        folderPath: workspaceDir,
        name: "Runtime config ownership eval",
        preset: "starter",
      },
    });
    list = workspaceItems(created).length > 0 ? created : await fetchOpenworkJson(ctx, "/workspaces");
    workspace = workspaceItems(list).find((item) => resolve(String(item?.path ?? "")) === workspaceDir)
      ?? workspaceItems(list).find((item) => item?.id === created?.activeId);
  }

  const workspaceId = String(workspace?.id ?? "").trim();
  ctx.assert(Boolean(workspaceId), `Could not create or find eval workspace at ${workspaceDir}`);

  await ctx.eval(`(async () => {
    const workspaceId = ${JSON.stringify(workspaceId)};
    const invoke = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!invoke) throw new Error("Desktop bridge is unavailable.");
    await invoke("workspaceSetSelected", workspaceId);
    await invoke("workspaceSetRuntimeActive", workspaceId);
    localStorage.setItem("openwork.react.activeWorkspace", workspaceId);
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...prefs, hasCompletedOnboarding: true }));
    return true;
  })()`, { awaitPromise: true });
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after selecting eval workspace",
  });

  ctx.runtimeConfigOwnership = { workspaceId, workspaceDir };
  ctx.log(`Using eval workspace ${workspaceId}: ${workspaceDir}`);
  return ctx.runtimeConfigOwnership;
}

function rememberRuntimeStatus(ctx, status) {
  const managedFilePath = typeof status?.managedFilePath === "string"
    ? assertDevDataPath(ctx, status.managedFilePath)
    : null;
  if (!managedFilePath) return;
  ctx.runtimeConfigOwnership = {
    ...(ctx.runtimeConfigOwnership ?? {}),
    managedFilePath,
    runtimeStorageDir: assertDevDataPath(ctx, dirname(managedFilePath)),
  };
}

async function readRuntimeConfigStatus(ctx) {
  const { workspaceId } = await ensureWorkspace(ctx);
  const status = await fetchOpenworkJson(ctx, `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`);
  rememberRuntimeStatus(ctx, status);
  return status;
}

async function readManagedFile(ctx) {
  if (!ctx.runtimeConfigOwnership?.managedFilePath) {
    await readRuntimeConfigStatus(ctx);
  }
  const managedFilePath = assertDevDataPath(ctx, ctx.runtimeConfigOwnership.managedFilePath);
  return readFile(managedFilePath, "utf8");
}

async function clearLegacySweepState(ctx) {
  const statePaths = runtimeStorageCandidates(ctx).map((dir) => join(dir, "legacy-sweep-state.json"));
  if (ctx.runtimeConfigOwnership?.runtimeStorageDir) {
    statePaths.push(join(ctx.runtimeConfigOwnership.runtimeStorageDir, "legacy-sweep-state.json"));
  }
  for (const path of uniqueStrings(statePaths)) {
    await rm(assertDevDataPath(ctx, path), { force: true });
  }
}

async function clearLegacyBackups(ctx) {
  const path = legacyConfigPath(ctx);
  const dir = dirname(path);
  const file = basename(path);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (entry.startsWith(`${file}.openwork-backup-`)) {
      await rm(assertDevDataPath(ctx, join(dir, entry)), { force: true });
    }
  }
}

async function seedLegacyConfig(ctx) {
  const path = legacyConfigPath(ctx);
  await mkdir(dirname(path), { recursive: true });
  await clearLegacyBackups(ctx);
  await clearLegacySweepState(ctx);
  await writeFile(path, LEGACY_CONTENT, "utf8");
  ctx.log(`Seeded legacy OpenCode config: ${path}`);
  return path;
}

async function readSweepState(ctx) {
  const status = await readRuntimeConfigStatus(ctx);
  if (status?.sweep) return status.sweep;
  const candidates = runtimeStorageCandidates(ctx);
  if (ctx.runtimeConfigOwnership?.runtimeStorageDir) candidates.unshift(ctx.runtimeConfigOwnership.runtimeStorageDir);
  for (const dir of uniqueStrings(candidates)) {
    try {
      return JSON.parse(await readFile(assertDevDataPath(ctx, join(dir, "legacy-sweep-state.json")), "utf8"));
    } catch {
      // Try the next dev-data runtime storage candidate.
    }
  }
  return null;
}

async function enableDeveloperMode(ctx) {
  await ctx.navigateHash("/settings/advanced");
  await ctx.waitForText("Developer mode", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const toggle = document.querySelector('[role="switch"][aria-label="Developer mode"]');
    if (!toggle) return false;
    toggle.scrollIntoView({ block: "center" });
    if (toggle.getAttribute("aria-checked") !== "true") toggle.click();
    return true;
  })()`);
  await ctx.waitFor(`localStorage.getItem("openwork.developerMode") === "1"`, {
    timeoutMs: 10_000,
    label: "developer mode enabled",
  });
  await ctx.waitForText("Debug", { timeoutMs: 10_000 });
}

async function scrollRuntimeCardIntoView(ctx) {
  await ctx.eval(`(() => {
    const heading = Array.from(document.querySelectorAll("div")).find((node) => (node.textContent ?? "").trim() === ${JSON.stringify(CARD_TITLE)});
    heading?.scrollIntoView({ block: "start" });
    return Boolean(heading);
  })()`);
}

async function openDebugSettings(ctx) {
  await ctx.navigateHash("/settings/debug");
  await ctx.waitForText(CARD_TITLE, { timeoutMs: 30_000 });
  await scrollRuntimeCardIntoView(ctx);
}

async function openRedactedManagedFile(ctx) {
  await openDebugSettings(ctx);
  await ctx.eval(`(() => {
    const summary = Array.from(document.querySelectorAll("summary")).find((node) => (node.textContent ?? "").includes(${JSON.stringify(REDACTED_CONTENT_LABEL)}));
    const details = summary?.closest("details");
    if (!summary || !details) return false;
    details.open = true;
    summary.scrollIntoView({ block: "center" });
    return true;
  })()`);
  await ctx.waitForText(REDACTED_CONTENT_VISIBLE_LABEL, { timeoutMs: 10_000 });
}

async function restartOpenworkServerFromDebug(ctx) {
  await openDebugSettings(ctx);
  await ctx.clickText("Restart OpenWork server", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return text.includes("Restarted OpenWork server.") || text.includes("Failed to restart OpenWork server.");
  })()`, {
    timeoutMs: 90_000,
    label: "OpenWork server restart result",
  });
  const text = await ctx.eval("document.body.innerText");
  ctx.assert(!text.includes("Failed to restart OpenWork server."), "OpenWork server restart failed.");
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after OpenWork server restart",
  });
}

async function setDisabledProviderThroughServer(ctx) {
  const { workspaceId } = await ensureWorkspace(ctx);
  ctx.log("Using the OpenWork server runtime-config route as the provider-toggle fallback for this isolated eval.");
  const result = await fetchOpenworkJson(ctx, `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/disabled-providers`, {
    method: "POST",
    body: { providers: [DISABLED_PROVIDER] },
  });
  ctx.assert(
    Array.isArray(result?.disabledProviders) && result.disabledProviders.includes(DISABLED_PROVIDER),
    `Expected ${DISABLED_PROVIDER} to be disabled, got ${JSON.stringify(result)}`,
  );
  await readRuntimeConfigStatus(ctx);
  return result;
}

function assertSeededGhosts(ctx, content) {
  ctx.assert(content.startsWith(LEGACY_HEADER), "Seeded legacy config is missing the header comment.");
  for (const expected of [
    "openwork-cloud",
    "stale-cloud.example.test",
    '"agent"',
    '"openwork"',
    '"default_agent"',
    "openwork-extensions-preview",
    "my-notion",
    "./plugins/my-plugin.js",
  ]) {
    ctx.assert(content.includes(expected), `Seeded legacy config is missing ${expected}.`);
  }
}

function assertSweptPersonalConfig(ctx, content) {
  ctx.assert(content.startsWith(LEGACY_HEADER), "Swept personal config did not preserve the header comment.");
  for (const removed of ["openwork-cloud", '"default_agent"', "openwork-extensions-preview"]) {
    ctx.assert(!content.includes(removed), `Swept personal config still contains ${removed}.`);
  }
  ctx.assert(content.includes("my-notion"), "Swept personal config lost the user-owned my-notion MCP entry.");
  ctx.assert(content.includes("./plugins/my-plugin.js"), "Swept personal config lost the user-owned plugin entry.");
}

function assertSweepState(ctx, state) {
  ctx.assert(state?.version === 1, "Legacy sweep state is missing or has the wrong version.");
  const path = legacyConfigPath(ctx);
  const file = state.files?.find((entry) => resolve(String(entry?.path ?? "")) === path);
  ctx.assert(Boolean(file), `Legacy sweep state did not include ${path}.`);
  for (const key of ["mcp.openwork-cloud", "agent.openwork", "default_agent", "plugin"]) {
    ctx.assert(file.removedKeys?.includes(key), `Legacy sweep state did not list removed key ${key}.`);
  }
  ctx.assert(typeof file.backupPath === "string" && file.backupPath.includes(".openwork-backup-"), "Legacy sweep state did not record a backup path.");
  return file;
}

export default {
  id: FLOW_ID,
  title: "Runtime config is owned by OpenWork's managed file without mutating personal OpenCode config",
  kind: "user-facing",
  steps: [
    {
      name: "Legacy ghosts are seeded only inside the dev-data home",
      run: async (ctx) => {
        await ctx.prove("A realistic legacy OpenCode config can be isolated in the dev-data home before migration", {
          voiceover: vo[0],
          action: async () => {
            await ensureWorkspace(ctx);
            await readRuntimeConfigStatus(ctx);
            await seedLegacyConfig(ctx);
            await ctx.navigateHash("/settings/advanced");
            await ctx.waitForText("Advanced", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const content = await readFile(legacyConfigPath(ctx), "utf8");
            assertSeededGhosts(ctx, content);
            await ctx.expectText("Advanced");
          },
          screenshot: {
            name: "legacy-ghosts-seeded-in-settings",
            requireText: ["Advanced"],
            hashIncludes: "/settings/advanced",
          },
        });
      },
    },
    {
      name: "Restart runs the one-time cleanup with backup evidence",
      run: async (ctx) => {
        await ctx.prove("The server restart sweeps OpenWork-owned leftovers, preserves user-owned config, and reports the backup", {
          voiceover: vo[1],
          action: async () => {
            await enableDeveloperMode(ctx);
            await restartOpenworkServerFromDebug(ctx);
            await openDebugSettings(ctx);
            await ctx.waitForText("Removed: mcp.openwork-cloud, agent.openwork, default_agent, plugin", { timeoutMs: 30_000 });
            await ctx.waitForText("Backup:", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const personalContent = await readFile(legacyConfigPath(ctx), "utf8");
            assertSweptPersonalConfig(ctx, personalContent);

            const state = await readSweepState(ctx);
            const sweptFile = assertSweepState(ctx, state);
            const backupPath = assertDevDataPath(ctx, sweptFile.backupPath);
            const backupContent = await readFile(backupPath, "utf8");
            ctx.assert(backupContent === LEGACY_CONTENT, "Legacy backup content did not match the original seeded file byte-for-byte.");

            await ctx.expectText(CARD_TITLE);
            await ctx.expectText("Removed: mcp.openwork-cloud, agent.openwork, default_agent, plugin");
            await ctx.expectText("Backup:");
          },
          screenshot: {
            name: "legacy-cleanup-backup-notice",
            requireText: [CARD_TITLE, "Legacy cleanup", "Backup:"],
            hashIncludes: "/settings/debug",
          },
        });
      },
    },
    {
      name: "Disabling a provider leaves personal config untouched and rebuilds deterministically",
      run: async (ctx) => {
        await ctx.prove("Disabling a provider updates only the managed runtime file, and a restart reproduces identical bytes", {
          voiceover: vo[2],
          action: async () => {
            const personalBefore = await readFile(legacyConfigPath(ctx), "utf8");
            ctx.runtimeConfigOwnership.personalHashBeforeProviderToggle = sha256(personalBefore);

            await setDisabledProviderThroughServer(ctx);
            await waitForNode(ctx, "managed file with disabled provider", async () => {
              const content = await readManagedFile(ctx);
              return content.includes(`"${DISABLED_PROVIDER}"`) ? content : null;
            });
            ctx.runtimeConfigOwnership.managedBytesBeforeRestart = await readManagedFile(ctx);

            await restartOpenworkServerFromDebug(ctx);
            await readRuntimeConfigStatus(ctx);
            await openDebugSettings(ctx);
          },
          assert: async () => {
            const personalAfter = await readFile(legacyConfigPath(ctx), "utf8");
            ctx.assert(
              sha256(personalAfter) === ctx.runtimeConfigOwnership.personalHashBeforeProviderToggle,
              "Personal OpenCode config changed after disabling a provider.",
            );

            const managedAfterRestart = await waitForNode(ctx, "managed file after restart", async () => {
              const content = await readManagedFile(ctx);
              return content.includes(`"${DISABLED_PROVIDER}"`) ? content : null;
            });
            const parsed = JSON.parse(managedAfterRestart);
            ctx.assert(
              Array.isArray(parsed.disabled_providers) && parsed.disabled_providers.includes(DISABLED_PROVIDER),
              `Managed runtime file did not contain disabled provider ${DISABLED_PROVIDER}.`,
            );
            ctx.assert(
              managedAfterRestart === ctx.runtimeConfigOwnership.managedBytesBeforeRestart,
              "Managed runtime config bytes changed across the restart.",
            );
            await ctx.expectText(CARD_TITLE);
            await ctx.expectText("Managed file:");
          },
          screenshot: {
            name: "provider-disabled-managed-file-stable",
            requireText: [CARD_TITLE, "Managed file:", "Last rebuilt:"],
            hashIncludes: "/settings/debug",
          },
        });
      },
    },
    {
      name: "Debug card exposes the managed file path, timestamp, and redacted content",
      run: async (ctx) => {
        await ctx.prove("Debug settings tells the complete managed-runtime-config story on one card", {
          voiceover: vo[3],
          action: async () => {
            await readRuntimeConfigStatus(ctx);
            await openRedactedManagedFile(ctx);
          },
          assert: async () => {
            const managedContent = await readManagedFile(ctx);
            const bodyText = await ctx.eval("document.body.innerText");
            ctx.assert(bodyText.includes(CARD_TITLE), "Debug card title is not visible.");
            ctx.assert(bodyText.includes(CARD_RULE), "Debug card did not show the one-writer rule.");
            ctx.assert(bodyText.includes("Managed file:"), "Debug card did not show the managed file path label.");
            ctx.assert(bodyText.includes("runtime-opencode-config.json"), "Debug card did not show the managed file path fragment.");
            ctx.assert(bodyText.includes("Last rebuilt:") && !bodyText.includes("Last rebuilt: missing"), "Debug card did not show a rebuilt timestamp.");
            ctx.assert(bodyText.includes(REDACTED_CONTENT_VISIBLE_LABEL), "Debug card did not show the redacted content disclosure.");
            ctx.assert(bodyText.includes("disabled_providers"), "Expanded redacted content did not show the managed file body.");
            if (managedContent.includes("Authorization")) {
              ctx.assert(bodyText.includes("[redacted]"), "Managed file has an Authorization header but the Debug card did not show a redacted value.");
            }
          },
          screenshot: {
            name: "debug-card-managed-runtime-config-story",
            requireText: [CARD_TITLE, "Managed file:", "runtime-opencode-config.json", REDACTED_CONTENT_VISIBLE_LABEL],
            hashIncludes: "/settings/debug",
          },
        });
      },
    },
  ],
};
