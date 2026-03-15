import AdmZip from "adm-zip";
import { parse } from "jsonc-parser";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceOpenworkConfig } from "../../../../app/src/app/lib/desktop-contract";

type SeedCommand = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

const ENTERPRISE_ARCHIVE_URL =
  "https://github.com/different-ai/openwork-enterprise/archive/refs/heads/main.zip";
const ENTERPRISE_SEED_MARKER = ".openwork-enterprise-creators";
const ENTERPRISE_SEED_IN_FLIGHT = new Set<string>();

function mergePlugins(existing: string[], required: readonly string[]) {
  const merged = [...existing];
  for (const plugin of required) {
    if (!merged.includes(plugin)) {
      merged.push(plugin);
    }
  }
  return merged;
}

function enterpriseSeedMarkerPath(root: string) {
  return path.join(root, ".opencode", ENTERPRISE_SEED_MARKER);
}

function sanitizeCommandName(raw: string) {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!trimmed) {
    return null;
  }

  const sanitized = Array.from(trimmed)
    .filter((character) => /[A-Za-z0-9_-]/.test(character))
    .join("");

  return sanitized || null;
}

function escapeYamlScalar(value: string) {
  return JSON.stringify(value);
}

function serializeCommandFrontmatter(command: SeedCommand) {
  const template = command.template.trim();
  if (!template) {
    throw new Error("command.template is required");
  }

  const lines = ["---"];
  if (command.description?.trim()) {
    lines.push(`description: ${escapeYamlScalar(command.description.trim())}`);
  }
  if (command.agent?.trim()) {
    lines.push(`agent: ${escapeYamlScalar(command.agent.trim())}`);
  }
  if (command.model?.trim()) {
    lines.push(`model: ${escapeYamlScalar(command.model.trim())}`);
  }
  if (command.subtask) {
    lines.push("subtask: true");
  }
  lines.push("---", "", template, "");
  return lines.join("\n");
}

async function seedWorkspaceGuide(skillRoot: string) {
  const guideDir = path.join(skillRoot, "workspace-guide");
  if (existsSync(guideDir)) {
    return;
  }

  await mkdir(guideDir, { recursive: true });
  await writeFile(
    path.join(guideDir, "SKILL.md"),
    `---
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
`,
  );
}

async function seedGetStartedSkill(skillRoot: string) {
  const skillDir = path.join(skillRoot, "get-started");
  if (existsSync(skillDir)) {
    return;
  }

  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
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
`,
  );
}

async function seedOpenworkAgent(agentsDir: string) {
  const agentPath = path.join(agentsDir, "openwork.md");
  if (existsSync(agentPath)) {
    return;
  }

  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    agentPath,
    `---
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
- \.opencode/skills/**
- \.opencode/agents/**
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

Specific User Requests
- If a user asks you to do something with a broswer, like 'open a new tab', check if you have access to the chrome-devtools-mcp - if not, then ask the user to add the 'Control Chrome' extension using the sidebar or via the worker settings.
`,
  );
}

async function seedCommands(commandsDir: string, preset: string) {
  const existingEntries = existsSync(commandsDir) ? await readdir(commandsDir) : [];
  if (existingEntries.length > 0) {
    return;
  }

  const defaults: SeedCommand[] = [
    {
      name: "learn-files",
      description: "Safe, practical file workflows",
      template: "Show me how to interact with files in this workspace. Include safe examples for reading, summarizing, and editing.",
    },
    {
      name: "learn-skills",
      description: "How skills work and how to create your own",
      template: "Explain what skills are, how to use them, and how to create a new skill for this workspace.",
    },
    {
      name: "learn-plugins",
      description: "What plugins are and how to install them",
      template: "Explain what plugins are and how to install them in this workspace.",
    },
  ];

  if (preset === "starter") {
    defaults.push({
      name: "Get Started",
      description: "Get started",
      template: "get started",
    });
  }

  await mkdir(commandsDir, { recursive: true });
  for (const command of defaults) {
    const name = sanitizeCommandName(command.name);
    if (!name) {
      continue;
    }

    const filePath = path.join(commandsDir, `${name}.md`);
    if (existsSync(filePath)) {
      continue;
    }

    await writeFile(filePath, serializeCommandFrontmatter(command));
  }
}

async function seedEnterpriseCreatorSkills(root: string, skillRoot: string) {
  const markerPath = enterpriseSeedMarkerPath(root);
  if (existsSync(markerPath)) {
    return;
  }

  const existing = new Set<string>(existsSync(skillRoot) ? await readdir(skillRoot) : []);
  const response = await fetch(ENTERPRISE_ARCHIVE_URL);
  if (!response.ok) {
    throw new Error(`Failed to download enterprise archive: ${response.status}`);
  }

  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName;
    const parts = entryName.split("/").filter(Boolean);
    if (parts.length < 5 || parts[1] !== ".opencode" || parts[2] !== "skills") {
      continue;
    }

    const skillName = parts[3] ?? "";
    if (!skillName.endsWith("-creator") || existing.has(skillName)) {
      continue;
    }

    const destRoot = path.join(skillRoot, skillName);
    const destPath = path.join(destRoot, ...parts.slice(4));

    if (entry.isDirectory) {
      await mkdir(destPath, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, entry.getData());
  }

  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, "seeded\n");
}

function spawnEnterpriseCreatorSkillsSeed(root: string, skillRoot: string) {
  const markerPath = enterpriseSeedMarkerPath(root);
  if (existsSync(markerPath) || ENTERPRISE_SEED_IN_FLIGHT.has(root)) {
    return;
  }

  ENTERPRISE_SEED_IN_FLIGHT.add(root);
  void seedEnterpriseCreatorSkills(root, skillRoot)
    .catch((error) => {
      console.warn(`[workspace] Failed to seed creator skills for ${root}:`, error);
    })
    .finally(() => {
      ENTERPRISE_SEED_IN_FLIGHT.delete(root);
    });
}

function createDefaultOpenworkConfig(workspacePath: string, preset: string): WorkspaceOpenworkConfig {
  return {
    version: 1,
    workspace: {
      name: path.basename(workspacePath) || "Workspace",
      createdAt: Date.now(),
      preset,
    },
    authorizedRoots: [workspacePath],
    reload: null,
  };
}

export async function ensureWorkspaceFiles(workspacePath: string, preset: string) {
  const root = workspacePath;
  const skillRoot = path.join(root, ".opencode", "skills");
  await mkdir(skillRoot, { recursive: true });
  await seedWorkspaceGuide(skillRoot);
  if (preset === "starter") {
    await seedGetStartedSkill(skillRoot);
    spawnEnterpriseCreatorSkillsSeed(root, skillRoot);
  }

  const agentsDir = path.join(root, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await seedOpenworkAgent(agentsDir);

  const commandsDir = path.join(root, ".opencode", "commands");
  await mkdir(commandsDir, { recursive: true });
  await seedCommands(commandsDir, preset);

  const configPathJsonc = path.join(root, "opencode.jsonc");
  const configPathJson = path.join(root, "opencode.json");
  const configPath = existsSync(configPathJsonc)
    ? configPathJsonc
    : existsSync(configPathJson)
      ? configPathJson
      : configPathJsonc;

  const configExists = existsSync(configPath);
  let configChanged = !configExists;
  let config: Record<string, unknown> = configExists
    ? ((parse(await readFile(configPath, "utf8")) as Record<string, unknown> | undefined) ?? {})
    : { $schema: "https://opencode.ai/config.json" };

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    config = { $schema: "https://opencode.ai/config.json" };
    configChanged = true;
  }

  const currentDefaultAgent = typeof config.default_agent === "string" ? config.default_agent.trim() : "";
  if (!currentDefaultAgent) {
    config.default_agent = "openwork";
    configChanged = true;
  }

  const requiredPlugins = preset === "starter" || preset === "automation" ? ["opencode-scheduler"] : [];
  if (requiredPlugins.length > 0) {
    const pluginValue = config.plugin;
    const existingPlugins = Array.isArray(pluginValue)
      ? pluginValue.filter((entry): entry is string => typeof entry === "string")
      : typeof pluginValue === "string"
        ? [pluginValue]
        : [];
    const merged = mergePlugins(existingPlugins, requiredPlugins);
    if (merged.length !== existingPlugins.length || merged.some((value, index) => value !== existingPlugins[index])) {
      config.plugin = merged;
      configChanged = true;
    }
  }

  if (preset === "starter") {
    const existingMcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)
      ? { ...(config.mcp as Record<string, unknown>) }
      : {};
    if (!("chrome-devtools" in existingMcp)) {
      existingMcp["chrome-devtools"] = {
        type: "local",
        command: ["npx", "-y", "chrome-devtools-mcp@latest"],
      };
      config.mcp = existingMcp;
      configChanged = true;
    }
  }

  if (configChanged) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  const openworkPath = path.join(root, ".opencode", "openwork.json");
  if (!existsSync(openworkPath)) {
    await mkdir(path.dirname(openworkPath), { recursive: true });
    await writeFile(openworkPath, `${JSON.stringify(createDefaultOpenworkConfig(workspacePath, preset), null, 2)}\n`, "utf8");
  }
}
