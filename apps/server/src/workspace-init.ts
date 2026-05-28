import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { openworkConfigPath, opencodeConfigPath } from "./workspace-files.js";
import { readJsoncFile, updateJsoncPath, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import type { ReloadReason } from "./types.js";

const BROWSER_PLUGIN = "opencode-chrome-devtools";
const LEGACY_BROWSER_MCP_KEYS = ["openwork-browser", "chrome", "chrome-devtools", "control-chrome"];

const OPENWORK_ARTIFACT_GUIDANCE = `<!-- OPENWORK_ARTIFACTS_START -->
## OpenWork Artifacts

OpenWork can preview, edit, and download standard artifacts when you create or update them in the workspace.

- Prefer standard output files for user-visible deliverables: Markdown (\`.md\`), CSV (\`.csv\`), Excel workbooks (\`.xlsx\`), and browser previews (\`index.html\` or a local \`http://localhost:<port>\` URL).
- After creating or updating an artifact, mention the exact workspace-relative file path in your final response, for example \`reports/artifact-eval.md\` or \`reports/artifact-eval.xlsx\`.
- Do not invent \`Workspace/<id>/...\` paths unless a tool returns them; prefer clean workspace-relative paths.
- For websites or React/UI previews, start the dev server when useful and mention the \`http://localhost:<port>\` URL. Socket URLs such as \`ws://localhost:<port>/...\` are diagnostic hints, not primary preview links.
- For spreadsheets, use \`.csv\` for simple tabular data and \`.xlsx\` when the user asks for Excel/XLS specifically.
<!-- OPENWORK_ARTIFACTS_END -->`;

const OPENWORK_AGENT = `---
description: OpenWork default agent
mode: primary
temperature: 0.2
---

You are OpenWork.

When the user refers to "you", they mean the OpenWork app and the current workspace.

Your job:
- Help the user work on files safely.
- Automate repeatable work.
- Keep behavior portable and reproducible.

<!-- OPENWORK_BROWSER_START -->
## Browser

OpenWork has a built-in browser that agents can control directly.
Browser tools (\`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_fill\`, \`browser_eval\`, \`browser_list\`, \`browser_screenshot\`) are available via the \`opencode-chrome-devtools\` plugin.

**OpenWork Browser**:
- \`browser_url\`: always use \`"http://127.0.0.1:{{BROWSER_CDP_PORT}}"\`.
- Use for browsing tasks. The user sees what you do in real time.
- Always call \`browser_list\` first to discover available targets, then use the appropriate \`target_id\`.
- Choose the built-in browser target (usually \`about:blank\` or the page URL). Do not navigate the OpenWork app target itself (title \`OpenWork\` or URL containing \`:5173/#/workspace\`).
- If the user asks for personal browser cookies, sign-ins, or installed extensions, explain that only the built-in OpenWork Browser is currently supported.
<!-- OPENWORK_BROWSER_END -->

## Memory

Two kinds:
1. Behavior memory (shareable, in git): \`.opencode/skills/**\`, \`.opencode/agents/**\`, repo docs
2. Private memory (never commit): tokens, credentials, local config, logs

Hard rule: never copy private memory into repo files. Store only redacted summaries, schemas, and stable pointers.

## Working style

- If required setup or credentials are missing, ask one targeted question and continue once provided.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.
- Prefer clear, practical steps over abstract explanations.

${OPENWORK_ARTIFACT_GUIDANCE}
`;

type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

type EnsureWorkspaceFilesResult = {
  changed: boolean;
  reloadReasons: ReloadReason[];
};

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

function isSchemaOnlyOpencodeConfig(config: Record<string, unknown>): boolean {
  return Object.keys(config).every((key) => key === "$schema");
}

async function ensureWorkspaceOpenworkConfig(workspaceRoot: string, preset: string): Promise<boolean> {
  const path = openworkConfigPath(workspaceRoot);
  if (await exists(path)) return false;
  const now = Date.now();
  const config: WorkspaceOpenworkConfig = {
    version: 1,
    workspace: {
      name: basename(workspaceRoot) || "Workspace",
      createdAt: now,
      preset,
    },
    authorizedRoots: [workspaceRoot],
    reload: null,
  };
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return true;
}

async function ensureOpencodeConfig(workspaceRoot: string): Promise<boolean> {
  const path = opencodeConfigPath(workspaceRoot);
  if (await exists(path)) {
    await readJsoncFile<Record<string, unknown>>(path, {});
    return false;
  }

  await writeJsoncFile(path, {
    $schema: "https://opencode.ai/config.json",
    default_agent: "openwork",
    plugin: [BROWSER_PLUGIN],
  });
  return true;
}

function resolveAgentTemplate(): string {
  const cdpPort = process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() || "9222";
  return OPENWORK_AGENT.replace("{{BROWSER_CDP_PORT}}", cdpPort);
}

async function ensureOpenworkAgent(workspaceRoot: string): Promise<boolean> {
  const agentsDir = join(workspaceRoot, ".opencode", "agents");
  const agentPath = join(agentsDir, "openwork.md");
  const agentContent = resolveAgentTemplate();
  await ensureDir(agentsDir);
  if (!(await exists(agentPath))) {
    await writeFile(agentPath, agentContent.endsWith("\n") ? agentContent : `${agentContent}\n`, "utf8");
    return true;
  }
  let current = await readFile(agentPath, "utf8");
  let changed = false;

  // Patch artifacts section
  const artStart = "<!-- OPENWORK_ARTIFACTS_START -->";
  const artEnd = "<!-- OPENWORK_ARTIFACTS_END -->";
  const artStartIdx = current.indexOf(artStart);
  const artEndIdx = current.indexOf(artEnd);
  if (artStartIdx >= 0 && artEndIdx > artStartIdx) {
    const patched = `${current.slice(0, artStartIdx)}${OPENWORK_ARTIFACT_GUIDANCE}${current.slice(artEndIdx + artEnd.length)}`;
    if (patched !== current) { current = patched; changed = true; }
  } else {
    current = `${current.trimEnd()}\n\n${OPENWORK_ARTIFACT_GUIDANCE}\n`;
    changed = true;
  }

  // Patch browser section (replace with resolved CDP port)
  const browserStart = "<!-- OPENWORK_BROWSER_START -->";
  const browserEnd = "<!-- OPENWORK_BROWSER_END -->";
  const bsIdx = current.indexOf(browserStart);
  const beIdx = current.indexOf(browserEnd);
  const resolvedBrowser = agentContent.slice(
    agentContent.indexOf(browserStart),
    agentContent.indexOf(browserEnd) + browserEnd.length,
  );
  if (bsIdx >= 0 && beIdx > bsIdx) {
    const oldBrowser = current.slice(bsIdx, beIdx + browserEnd.length);
    if (oldBrowser !== resolvedBrowser) {
      current = current.slice(0, bsIdx) + resolvedBrowser + current.slice(beIdx + browserEnd.length);
      changed = true;
    }
  }

  if (changed) {
    await writeFile(agentPath, current, "utf8");
    return true;
  }
  return false;
}

async function ensureBrowserPlugin(workspaceRoot: string): Promise<boolean> {
  const configPath = opencodeConfigPath(workspaceRoot);
  const { data: config } = await readJsoncFile<Record<string, unknown>>(configPath, {});

  const hasPlugin = Array.isArray(config.plugin) && (config.plugin as string[]).includes(BROWSER_PLUGIN);
  const mcp = typeof config.mcp === "object" && config.mcp !== null ? config.mcp as Record<string, unknown> : null;
  const hasLegacyMcps = mcp ? LEGACY_BROWSER_MCP_KEYS.some((key) => key in mcp) : false;
  const shouldClaimDesktopCreatedConfig = await exists(openworkConfigPath(workspaceRoot)) && isSchemaOnlyOpencodeConfig(config);
  const isOpenWorkOwned = config.default_agent === "openwork" || shouldClaimDesktopCreatedConfig;

  if (hasPlugin && !hasLegacyMcps) return false;

  const updates: Record<string, unknown> = {};

  // Add the plugin if missing (only for OpenWork-owned workspaces or legacy migrations)
  if (!hasPlugin && (isOpenWorkOwned || hasLegacyMcps)) {
    const existing = Array.isArray(config.plugin) ? config.plugin as string[] : [];
    updates.plugin = [...existing, BROWSER_PLUGIN];
  }

  if (shouldClaimDesktopCreatedConfig) {
    updates.default_agent = "openwork";
  }

  if (!Object.keys(updates).length && !hasLegacyMcps) return false;

  if (Object.keys(updates).length) {
    await updateJsoncTopLevel(configPath, updates);
  }

  // Remove stale MCP entries individually to avoid clobbering other keys
  if (hasLegacyMcps && mcp) {
    for (const key of LEGACY_BROWSER_MCP_KEYS) {
      if (key in mcp) {
        await updateJsoncPath(configPath, ["mcp", key], undefined);
      }
    }
  }

  return true;
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<EnsureWorkspaceFilesResult> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  await ensureDir(workspaceRoot);
  const reloadReasons = new Set<ReloadReason>();
  if (await ensureOpencodeConfig(workspaceRoot)) reloadReasons.add("config");
  if (await ensureBrowserPlugin(workspaceRoot)) reloadReasons.add("config");
  if (await ensureOpenworkAgent(workspaceRoot)) reloadReasons.add("agents");
  const openworkConfigChanged = await ensureWorkspaceOpenworkConfig(workspaceRoot, preset);
  return {
    changed: openworkConfigChanged || reloadReasons.size > 0,
    reloadReasons: Array.from(reloadReasons),
  };
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
