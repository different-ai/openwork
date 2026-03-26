import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { upsertSkill } from "./skills.js";
import { upsertCommand } from "./commands.js";
import { readJsoncFile, writeJsoncFile } from "./jsonc.js";
import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { openworkConfigPath, opencodeConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";

const WORKSPACE_GUIDE = `---
name: workspace-guide
description: Workspace guide to introduce OpenWork and onboard new users.
---

# Welcome to OpenWork

Hi, I'm Ben and this is OpenWork. It's an open-source alternative to Claude's cowork. It helps you work on your files with AI and automate the mundane tasks so you don't have to.

Before we start, use the question tool to ask:
"Are you more technical or non-technical? I'll tailor the explanation."

## If the person is non-technical
OpenWork feels like a chat app, but it can safely work with the files you allow. Put files in this workspace and I can summarize them, create new ones, or help organize them.

Try:
- "Summarize the files in this workspace."
- "Create a checklist for my week."
- "Draft a short summary from this document."

## Skills and plugins (simple)
Skills add new capabilities. Plugins add advanced features like scheduling or browser automation. We can add them later when you're ready.

## If the person is technical
OpenWork is a GUI for OpenCode. Everything that works in OpenCode works here.

Most reliable setup today:
1) Install OpenCode from opencode.ai
2) Configure providers there (models and API keys)
3) Come back to OpenWork and start a session

Skills:
- Install from the Skills tab, or add them to this workspace.
- Docs: https://opencode.ai/docs/skills

Plugins:
- Configure in opencode.json or use the Plugins tab.
- Docs: https://opencode.ai/docs/plugins/

MCP servers:
- Add external tools via opencode.json.
- Docs: https://opencode.ai/docs/mcp-servers/

Config reference:
- Docs: https://opencode.ai/docs/config/

End with two friendly next actions to try in OpenWork.
`;

const GET_STARTED_SKILL = `---
name: get-started
description: Guide users through the get started setup and Chrome DevTools demo.
---

## When to use
- Always load this skill when the user says "get started".

## What to do
- Reply with these four lines, exactly and in order:
  1) hey there welcome this is openwork
  2) we've pre-configured you with a couple tools
  3) Get Started
  4) write "hey go on google.com"

## Then
- If the user writes "go on google.com" (or "hey go on google.com"), use the chrome-devtools MCP to open the site.
- After the navigation completes, reply: "I'm on <site>" where <site> is the final URL or page title they asked for.
`;

const OPENWORK_AGENT = `---
description: OpenWork default agent (safe, mobile-first, self-referential)
mode: primary
temperature: 0.2
---

You are OpenWork.

When the user refers to "you", they mean the OpenWork app and the current workspace.

Your job:
- Help the user work on files safely.
- Automate repeatable work.
- Keep behavior portable and reproducible.

Memory (two kinds)
1) Behavior memory (shareable, in git)
- ".opencode/skills/**"
- ".opencode/agents/**"
- repo docs

2) Private memory (never commit)
- Tokens, IDs, credentials
- Local DBs/logs/config files (gitignored)
- Notion pages/databases (if configured via MCP)

Hard rule: never copy private memory into repo files verbatim. Store only redacted summaries, schemas/templates, and stable pointers.

Reconstruction-first
- Do not assume env vars or prior setup.
- If required state is missing, ask one targeted question.
- After the user provides it, store it in private memory and continue.

Verification-first
- If you change code, run the smallest meaningful test or smoke check.
- If you touch UI or remote behavior, validate end-to-end and capture logs on failure.

Incremental adoption loop
- Do the task once end-to-end.
- If steps repeat, factor them into a skill.
- If the work becomes ongoing, create/refine an agent role.
- If it should run regularly, schedule it and store outputs in private memory.
`;

type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  blueprint?: Record<string, unknown> | null;
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

function buildDefaultWorkspaceBlueprint(_preset: string): Record<string, unknown> {
  return {
    emptyState: {
      title: "What do you want to do?",
      body: "Pick a starting point or just type below.",
      starters: [
        {
          id: "csv-help",
          kind: "prompt",
          title: "Work on a CSV",
          description: "Clean up or generate spreadsheet data.",
          prompt: "Help me create or edit CSV files on this computer.",
        },
        {
          id: "starter-connect-openai",
          kind: "action",
          title: "Connect ChatGPT",
          description: "Add your OpenAi provider so ChatGPT models are ready in new sessions.",
          action: "connect-openai",
        },
        {
          id: "browser-automation",
          kind: "session",
          title: "Automate Chrome",
          description: "Start a browser automation conversation right away.",
          prompt: "Help me connect to Chrome and automate a repetitive task.",
        },
      ],
    },
    sessions: [
      {
        id: "welcome-to-openwork",
        title: "Welcome to OpenWork",
        openOnFirstLoad: true,
        messages: [
          {
            role: "assistant",
            text:
              "Hi welcome to OpenWork!\n\nPeople use us to write .csv files on their computer, connect to Chrome and automate repetitive tasks, and sync contacts to Notion.\n\nBut the only limit is your imagination.\n\nWhat would you want to do?",
          },
        ],
      },
      {
        id: "csv-playbook",
        title: "CSV workflow ideas",
        messages: [
          {
            role: "assistant",
            text: "I can help you generate, clean, merge, and summarize CSV files. What kind of CSV work do you want to automate?",
          },
          {
            role: "user",
            text: "I want to combine exports from multiple tools into one clean CSV.",
          },
        ],
      },
    ],
  };
}

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

function mergePlugins(existing: string[], required: string[]): string[] {
  const next = existing.slice();
  for (const plugin of required) {
    if (!next.includes(plugin)) {
      next.push(plugin);
    }
  }
  return next;
}

async function ensureOpenworkAgent(workspaceRoot: string): Promise<void> {
  const agentsDir = join(workspaceRoot, ".opencode", "agents");
  const agentPath = join(agentsDir, "openwork.md");
  if (await exists(agentPath)) return;
  await ensureDir(agentsDir);
  await writeFile(agentPath, OPENWORK_AGENT.endsWith("\n") ? OPENWORK_AGENT : `${OPENWORK_AGENT}\n`, "utf8");
}

async function ensureStarterSkills(workspaceRoot: string, preset: string): Promise<void> {
  await ensureDir(projectSkillsDir(workspaceRoot));
  await upsertSkill(workspaceRoot, {
    name: "workspace-guide",
    description: "Workspace guide to introduce OpenWork and onboard new users.",
    content: WORKSPACE_GUIDE,
  });
  if (preset === "starter") {
    await upsertSkill(workspaceRoot, {
      name: "get-started",
      description: "Guide users through the get started setup and Chrome DevTools demo.",
      content: GET_STARTED_SKILL,
    });
  }
}

async function ensureStarterCommands(workspaceRoot: string, preset: string): Promise<void> {
  await ensureDir(projectCommandsDir(workspaceRoot));
  await upsertCommand(workspaceRoot, {
    name: "learn-files",
    description: "Safe, practical file workflows",
    template: "Show me how to interact with files in this workspace. Include safe examples for reading, summarizing, and editing.",
  });
  await upsertCommand(workspaceRoot, {
    name: "learn-skills",
    description: "How skills work and how to create your own",
    template: "Explain what skills are, how to use them, and how to create a new skill for this workspace.",
  });
  await upsertCommand(workspaceRoot, {
    name: "learn-plugins",
    description: "What plugins are and how to install them",
    template: "Explain what plugins are and how to install them in this workspace.",
  });
  if (preset === "starter") {
    await upsertCommand(workspaceRoot, {
      name: "get-started",
      description: "Get started",
      template: "get started",
    });
  }
}

async function ensureOpencodeConfig(workspaceRoot: string, preset: string): Promise<void> {
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

  const requiredPlugins = preset === "starter" || preset === "automation"
    ? ["opencode-scheduler"]
    : [];
  if (requiredPlugins.length > 0) {
    const currentPlugins = Array.isArray(next.plugin)
      ? next.plugin.filter((value: unknown): value is string => typeof value === "string")
      : typeof next.plugin === "string"
        ? [next.plugin]
        : [];
    next.plugin = mergePlugins(currentPlugins, requiredPlugins);
  }

  if (preset === "starter") {
    const currentMcp = next.mcp && typeof next.mcp === "object" && !Array.isArray(next.mcp)
      ? { ...(next.mcp as Record<string, unknown>) }
      : {};
    if (!("control-chrome" in currentMcp)) {
      currentMcp["control-chrome"] = {
        type: "local",
        command: ["chrome-devtools-mcp"],
      };
    }
    next.mcp = currentMcp;
  }

  await writeJsoncFile(path, next);
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
    blueprint: buildDefaultWorkspaceBlueprint(preset),
    reload: null,
  };
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<void> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  await ensureDir(workspaceRoot);
  await ensureStarterSkills(workspaceRoot, preset);
  await ensureOpenworkAgent(workspaceRoot);
  await ensureStarterCommands(workspaceRoot, preset);
  await ensureOpencodeConfig(workspaceRoot, preset);
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
