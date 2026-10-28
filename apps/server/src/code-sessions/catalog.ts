import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Per-client catalogs for the Code tab composer: which models and which
 * agent modalities a driven run can use.
 *
 * - Models: OpenCode lists its own (`opencode models`, cached briefly);
 *   Claude Code accepts a small well-known set through --model.
 * - Agents (the modality): the user's convention is an `AGENTS/*.md` folder,
 *   found next to the project or in the global OpenCode config dir, plus
 *   each client's native discovery folder and built-in agents.
 */

export type ClientCatalog = {
  models: string[];
  agents: string[];
  /** Whether the driven run can apply a thinking-effort level. */
  effort: "supported" | "unsupported";
};

const CATALOG_TTL_MS = 60_000;
const modelsCache = new Map<string, { at: number; models: string[] }>();

async function fileStemNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length))
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** `opencode models` output, one provider/model per line; cached 60s. */
async function opencodeModels(cwd: string): Promise<string[]> {
  const cached = modelsCache.get(cwd);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "opencode", "models"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    const done = () => {
      const models = stripAnsi(out)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("/") && !line.startsWith("="))
        .slice(0, 200);
      modelsCache.set(cwd, { at: Date.now(), models });
      resolve(models);
    };
    child.on("exit", done);
    child.on("error", () => {
      modelsCache.set(cwd, { at: Date.now(), models: [] });
      resolve([]);
    });
  });
}

function globalOpenCodeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME?.trim()
    ? join(env.XDG_CONFIG_HOME.trim(), "opencode")
    : join(homedir(), ".config", "opencode");
}

/** Built-ins first, then AGENTS/*.md (project and global) and native agent dirs. */
export async function catalogAgents(
  projectDir: string,
  builtins: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const globalDir = globalOpenCodeDir(env);
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const name of [
    ...builtins,
    ...(await fileStemNames(join(projectDir, "AGENTS"))),
    ...(await fileStemNames(join(projectDir, ".opencode", "agent"))),
    ...(await fileStemNames(join(projectDir, ".claude", "agents"))),
    ...(await fileStemNames(join(globalDir, "AGENTS"))),
    ...(await fileStemNames(join(globalDir, "agent"))),
  ]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    agents.push(name);
  }
  return agents;
}

export type CatalogOptions = {
  /** Models list override, for tests. */
  modelsOverride?: string[];
  /** Home dir override, for tests. */
  homeDir?: string;
};

export async function clientCatalog(
  client: string,
  projectDir: string,
  options: CatalogOptions = {},
): Promise<ClientCatalog> {
  if (client === "opencode") {
    const models = options.modelsOverride ?? await opencodeModels(projectDir);
    const globalDir = options.homeDir
      ? join(options.homeDir, ".config", "opencode")
      : globalOpenCodeDir();
    const agents: string[] = [];
    const seen = new Set<string>();
    for (const name of [
      "build",
      "plan",
      ...(await fileStemNames(join(projectDir, "AGENTS"))),
      ...(await fileStemNames(join(projectDir, ".opencode", "agent"))),
      ...(await fileStemNames(join(globalDir, "AGENTS"))),
      ...(await fileStemNames(join(globalDir, "agent"))),
    ]) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      agents.push(name);
    }
    // The run CLI has no effort flag: the model's config governs reasoning.
    return { models, agents, effort: "unsupported" };
  }
  if (client === "claude-code") {
    return {
      models: ["default", "sonnet", "opus", "haiku"],
      agents: await catalogAgents(projectDir, []),
      // Applied through MAX_THINKING_TOKENS on the driven child.
      effort: "supported",
    };
  }
  return { models: [], agents: [], effort: "unsupported" };
}
