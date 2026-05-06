import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { openworkConfigPath, opencodeConfigPath } from "./workspace-files.js";
import { readJsoncFile, writeJsoncFile } from "./jsonc.js";

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

## Browser

OpenWork has a built-in browser and can also control the user's external Chrome.

Two MCP tool sets are available:

1. **openwork-browser** — Built-in browser panel inside the app.
   - The panel opens automatically when you call any openwork-browser tool.
   - Use this for general browsing tasks ("go to facebook.com", "search for X").
   - Call \`openwork-browser_hide_browser\` when the browsing task is done.
   - The user can see what you're doing in real time.

2. **chrome** — The user's real Chrome browser (external).
   - Use this when the user needs their real cookies, sign-ins, or extensions
     ("check my gmail", "open my github notifications").
   - **Always call \`chrome_chrome_status\` first** before using any other chrome tool.
   - If status is unavailable, tell the user:
     "Enable remote debugging in Chrome: go to chrome://inspect/#remote-debugging,
     turn it on, and allow incoming connections. No restart needed on Chrome 144+."
   - Do NOT attempt to kill, restart, or relaunch Chrome yourself.
   - Do NOT run bash commands to start Chrome with --remote-debugging-port.
   - If the user cannot enable debugging, offer the built-in browser as a fallback.

Default to **openwork-browser** unless the user explicitly needs their real
browser session (cookies, sign-ins, extensions). If the user says "go to X"
without specifying, use the built-in browser.

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

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

async function ensureWorkspaceOpenworkConfig(workspaceRoot: string, preset: string): Promise<void> {
  const path = openworkConfigPath(workspaceRoot);
  if (await exists(path)) return;
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
}

async function ensureOpencodeConfig(workspaceRoot: string): Promise<void> {
  const path = opencodeConfigPath(workspaceRoot);
  const { data } = await readJsoncFile<Record<string, unknown>>(path, {
    $schema: "https://opencode.ai/config.json",
  });
  const next: Record<string, unknown> = data && typeof data === "object" && !Array.isArray(data)
    ? { ...data }
    : { $schema: "https://opencode.ai/config.json" };

  if (typeof next.default_agent !== "string" || !next.default_agent.trim()) {
    next.default_agent = "openwork";
  }

  await writeJsoncFile(path, next);
}

async function ensureOpenworkAgent(workspaceRoot: string): Promise<void> {
  const agentsDir = join(workspaceRoot, ".opencode", "agents");
  const agentPath = join(agentsDir, "openwork.md");
  if (await exists(agentPath)) return;
  await ensureDir(agentsDir);
  await writeFile(agentPath, OPENWORK_AGENT.endsWith("\n") ? OPENWORK_AGENT : `${OPENWORK_AGENT}\n`, "utf8");
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<void> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  await ensureDir(workspaceRoot);
  await ensureOpencodeConfig(workspaceRoot);
  await ensureOpenworkAgent(workspaceRoot);
  await ensureWorkspaceOpenworkConfig(workspaceRoot, preset);
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
