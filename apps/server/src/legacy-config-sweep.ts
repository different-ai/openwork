import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { ServerConfig } from "./types.js";
import { ensureDir, exists } from "./utils.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";

export type LegacyConfigSweepFile = {
  path: string;
  removedKeys: string[];
  backupPath: string | null;
};

export type LegacyConfigSweepState = {
  version: 1;
  sweptAt: string;
  files: LegacyConfigSweepFile[];
  error?: string;
};

export type LegacyConfigSweepOptions = {
  homeDir?: string;
  now?: Date;
};

const OPENWORK_PLUGIN_MARKERS = [
  "openwork-extensions-preview",
  "openwork-capabilities-knowledge",
  "openwork-office-attachments",
  "openwork-anthropic-adaptive-thinking",
  "openwork-anthropic-tool-schema",
];

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backupTimestamp(date: Date): string {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("");
}

function legacyConfigTargets(homeDir: string): string[] {
  const base = join(homeDir, ".config", "opencode");
  return [
    join(base, "config.json"),
    join(base, "opencode.json"),
    join(base, "opencode.jsonc"),
  ];
}

function matchesOpenworkPlugin(value: string): boolean {
  return value.includes("opencode-plugins/openwork-") || OPENWORK_PLUGIN_MARKERS.some((marker) => value.includes(marker));
}

function parseJsoncObject(content: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const details = errors.map((error) => printParseErrorCode(error.error)).join(", ");
    throw new Error(`Failed to parse legacy OpenCode config (${details})`);
  }
  return isRecord(parsed) ? parsed : {};
}

function removeJsoncPath(content: string, path: Array<string | number>): string {
  return applyEdits(content, modify(content, path, undefined, { formattingOptions }));
}

function setJsoncPath(content: string, path: Array<string | number>, value: unknown): string {
  return applyEdits(content, modify(content, path, value, { formattingOptions }));
}

export function sweepLegacyConfigContent(content: string): { content: string; removedKeys: string[] } {
  const parsed = parseJsoncObject(content);
  const removedKeys: string[] = [];
  let updated = content;

  if (isRecord(parsed.mcp) && Object.hasOwn(parsed.mcp, "openwork-cloud")) {
    updated = removeJsoncPath(updated, ["mcp", "openwork-cloud"]);
    removedKeys.push("mcp.openwork-cloud");
  }

  if (isRecord(parsed.agent) && Object.hasOwn(parsed.agent, "openwork")) {
    updated = removeJsoncPath(updated, ["agent", "openwork"]);
    removedKeys.push("agent.openwork");
  }

  if (parsed.default_agent === "openwork") {
    updated = removeJsoncPath(updated, ["default_agent"]);
    removedKeys.push("default_agent");
  }

  if (Array.isArray(parsed.plugin)) {
    const nextPlugin = parsed.plugin.filter((entry) => typeof entry !== "string" || !matchesOpenworkPlugin(entry));
    if (nextPlugin.length !== parsed.plugin.length) {
      updated = nextPlugin.length > 0
        ? setJsoncPath(updated, ["plugin"], nextPlugin)
        : removeJsoncPath(updated, ["plugin"]);
      removedKeys.push("plugin");
    }
  }

  return { content: updated.endsWith("\n") ? updated : `${updated}\n`, removedKeys };
}

export function legacySweepStatePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "legacy-sweep-state.json");
}

function normalizeSweepFile(value: unknown): LegacyConfigSweepFile | null {
  if (!isRecord(value) || typeof value.path !== "string" || !Array.isArray(value.removedKeys)) return null;
  const removedKeys = value.removedKeys.filter((entry) => typeof entry === "string");
  const backupPath = typeof value.backupPath === "string" ? value.backupPath : null;
  return { path: value.path, removedKeys, backupPath };
}

function normalizeSweepState(value: unknown): LegacyConfigSweepState | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.sweptAt !== "string" || !Array.isArray(value.files)) {
    return null;
  }
  const files = value.files.flatMap((entry) => {
    const file = normalizeSweepFile(entry);
    return file ? [file] : [];
  });
  return {
    version: 1,
    sweptAt: value.sweptAt,
    files,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

export async function readLegacyConfigSweepState(config: ServerConfig): Promise<LegacyConfigSweepState | null> {
  try {
    const raw = await readFile(legacySweepStatePath(config), "utf8");
    return normalizeSweepState(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeLegacyConfigSweepState(config: ServerConfig, state: LegacyConfigSweepState): Promise<void> {
  const path = legacySweepStatePath(config);
  await ensureDir(runtimeStorageDir(config));
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function sweepLegacyOpenCodeConfig(
  config: ServerConfig,
  options?: LegacyConfigSweepOptions,
): Promise<LegacyConfigSweepState> {
  const existing = await readLegacyConfigSweepState(config);
  if (existing && !existing.error) return existing;

  const now = options?.now ?? new Date();
  const state: LegacyConfigSweepState = {
    version: 1,
    sweptAt: now.toISOString(),
    files: [],
  };

  try {
    for (const path of legacyConfigTargets(options?.homeDir ?? homedir())) {
      if (!(await exists(path))) continue;
      const original = await readFile(path, "utf8");
      const swept = sweepLegacyConfigContent(original);
      const file: LegacyConfigSweepFile = {
        path,
        removedKeys: swept.removedKeys,
        backupPath: null,
      };

      if (swept.removedKeys.length > 0) {
        const backupPath = `${path}.openwork-backup-${backupTimestamp(now)}`;
        await copyFile(path, backupPath);
        await writeFile(path, swept.content, "utf8");
        file.backupPath = backupPath;
      }

      state.files.push(file);
    }
  } catch (error) {
    state.error = errorMessage(error);
  }

  await writeLegacyConfigSweepState(config, state).catch(() => undefined);
  return state;
}
