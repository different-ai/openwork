import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { readJsoncFile } from "./jsonc.js";
import type { ReloadReason, WorkspaceInfo } from "./types.js";

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

function errorStringField(error: unknown, field: "code" | "path" | "syscall"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Object.getOwnPropertyDescriptor(error, field)?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the default per-workspace openwork config metadata. The openwork
 * config is now stored in the runtime DB (see
 * `seedOpenworkWorkspaceConfigIfEmpty`), not in `.opencode/openwork.json`, so
 * this no longer writes a file. Exposed so the workspace-creation route can
 * seed the DB row with the same defaults.
 */
export function defaultWorkspaceOpenworkConfig(workspaceRoot: string, preset: string): WorkspaceOpenworkConfig {
  return {
    version: 1,
    workspace: {
      name: basename(workspaceRoot) || "Workspace",
      createdAt: Date.now(),
      preset,
    },
    authorizedRoots: [workspaceRoot],
    reload: null,
  };
}

async function ensureOpencodeConfig(workspaceRoot: string): Promise<boolean> {
  const path = opencodeConfigPath(workspaceRoot);
  if (await exists(path)) {
    await readJsoncFile<Record<string, unknown>>(path, {}, { allowInvalid: true });
  }
  return false;
}

const NOT_WRITABLE_CODES = new Set(["EPERM", "EACCES", "EROFS"]);

/**
 * Turn a permission failure while writing inside a workspace (for example a
 * workspace at `C:\Program Files`) into a clear, expected API error instead
 * of an unhandled 500. Other errors pass through unchanged.
 */
export function workspaceWriteError(error: unknown, workspaceRoot: string): unknown {
  const fsCode = errorStringField(error, "code");
  if (!fsCode || !NOT_WRITABLE_CODES.has(fsCode)) return error;
  return new ApiError(403, "workspace_not_writable", "OpenWork can't write to this folder. Choose a folder you own, such as one in your user folder.", {
    path: workspaceRoot,
    fsCode,
    fsPath: errorStringField(error, "path"),
  });
}

/** Create the workspace's `.opencode` folder, failing clearly when the folder is read-only for this user. */
export async function ensureWorkspaceWritable(workspaceRoot: string): Promise<void> {
  try {
    await ensureDir(join(workspaceRoot, ".opencode"));
  } catch (error) {
    throw workspaceWriteError(error, workspaceRoot);
  }
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<EnsureWorkspaceFilesResult> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  try {
    await ensureDir(workspaceRoot);
  } catch (error) {
    throw new ApiError(409, "workspace_inaccessible", "Workspace path is not accessible", {
      path: workspaceRoot,
      fsCode: errorStringField(error, "code"),
      syscall: errorStringField(error, "syscall"),
      fsPath: errorStringField(error, "path"),
    });
  }
  const reloadReasons = new Set<ReloadReason>();
  if (await ensureOpencodeConfig(workspaceRoot)) reloadReasons.add("config");
  // openwork config is seeded into the runtime DB by the caller, not written
  // as a file here.
  void preset;
  return {
    changed: reloadReasons.size > 0,
    reloadReasons: Array.from(reloadReasons),
  };
}

/**
 * Provision workspace files for every workspace that has local files to set up.
 *
 * Skips any workspace without a resolved local path, which would otherwise
 * reach ensureWorkspaceFiles() — which throws
 * `invalid_workspace_path` on a blank path — and abort server startup. Local
 * provisioning failures are logged and skipped so one stale path cannot abort
 * startup. Shared by the embedded-server and CLI boot paths.
 */
export async function ensureLocalWorkspaceFiles(
  workspaces: ReadonlyArray<Pick<WorkspaceInfo, "path" | "preset">>,
): Promise<void> {
  for (const workspace of workspaces) {
    if (!workspace.path.trim()) continue;
    try {
      await ensureWorkspaceFiles(workspace.path, workspace.preset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to provision workspace files at ${workspace.path}: ${message}`);
    }
  }
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
