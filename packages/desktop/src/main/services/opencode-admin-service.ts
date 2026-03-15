import { ipcMain } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExecResult } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";
import { createDefaultWorkspaceRegistryStore } from "./workspace-registry-store";

function opencodeExecutableName() {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function opencodeCmdName() {
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

function bunEnvOverrides() {
  const overrides: Record<string, string> = {
    BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
  };

  const sanitize = (raw: string) => {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    let changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const inline = token.startsWith("--dns-result-order=") ? token.slice("--dns-result-order=".length) : null;
      if (inline !== null) {
        if (inline === "ipv4first" || inline === "verbatim") kept.push(token);
        else changed = true;
        continue;
      }
      if (token === "--dns-result-order") {
        const next = tokens[index + 1];
        if (next === "ipv4first" || next === "verbatim") kept.push(token, next);
        else changed = true;
        index += 1;
        continue;
      }
      kept.push(token);
    }
    return changed ? kept.join(" ") : null;
  };

  for (const key of ["BUN_OPTIONS", "NODE_OPTIONS"] as const) {
    const value = process.env[key];
    if (!value) continue;
    const sanitized = sanitize(value);
    if (sanitized) overrides[key] = sanitized;
  }

  return overrides;
}

function commonToolPaths() {
  const home = os.homedir();
  const paths: string[] = [];
  if (process.platform === "darwin") {
    paths.push("/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin");
    paths.push(
      path.join(home, ".nvm", "current", "bin"),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  } else if (process.platform === "linux") {
    paths.push("/usr/local/bin", "/usr/local/sbin");
    paths.push(
      path.join(home, ".nvm", "current", "bin"),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  } else {
    paths.push(path.join(home, ".volta", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".cargo", "bin"));
    if (process.env.LOCALAPPDATA) paths.push(path.join(process.env.LOCALAPPDATA, "pnpm"));
    if (process.env.APPDATA) paths.push(path.join(process.env.APPDATA, "npm"));
  }
  return paths.filter((entry) => existsSync(entry));
}

function sourceSidecarDir() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../resources/sidecars");
}

function pathEnv() {
  const sidecarDirs = [path.dirname(process.execPath), process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null, process.resourcesPath ?? null, sourceSidecarDir()]
    .filter((entry): entry is string => Boolean(entry) && existsSync(entry as string));
  const entries = [...sidecarDirs, ...commonToolPaths(), ...(process.env.PATH?.split(path.delimiter) ?? [])];
  return Array.from(new Set(entries.filter(Boolean))).join(path.delimiter);
}

function resolveInPath(name: string) {
  for (const dir of pathEnv().split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveEnginePath(preferSidecar: boolean, opencodeBinPath?: string | null) {
  const customPath = opencodeBinPath?.trim() || process.env.OPENCODE_BIN_PATH?.trim();
  if (customPath && existsSync(customPath)) {
    return customPath;
  }

  if (preferSidecar) {
    for (const candidate of [
      path.join(path.dirname(process.execPath), opencodeExecutableName()),
      process.resourcesPath ? path.join(process.resourcesPath, "sidecars", opencodeExecutableName()) : null,
      process.resourcesPath ? path.join(process.resourcesPath, opencodeExecutableName()) : null,
      path.join(sourceSidecarDir(), opencodeExecutableName()),
    ]) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  }

  return resolveInPath(opencodeExecutableName()) || (process.platform === "win32" ? resolveInPath(opencodeCmdName()) : null);
}

async function validateProjectDir(projectDir: string) {
  const trimmed = projectDir.trim();
  if (!trimmed) {
    throw new Error("project_dir is required");
  }
  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved)) {
    throw new Error("Failed to resolve project_dir: path does not exist");
  }
  const canonical = await realpath(resolved);

  const store = createDefaultWorkspaceRegistryStore();
  const state = await store.load();
  const roots = new Set<string>();
  for (const workspace of state.workspaces) {
    if (workspace.workspaceType !== "local") continue;
    try {
      roots.add(await realpath(workspace.path));
    } catch {
      // ignore bad workspace path
    }
    try {
      const openworkPath = path.join(workspace.path, ".opencode", "openwork.json");
      if (!existsSync(openworkPath)) continue;
      const raw = await readFile(openworkPath, "utf8");
      const config = JSON.parse(raw) as { authorizedRoots?: string[] };
      for (const root of config.authorizedRoots ?? []) {
        if (!root.trim()) continue;
        try {
          roots.add(await realpath(root));
        } catch {
          // ignore bad root
        }
      }
    } catch {
      // ignore malformed config
    }
  }

  if (roots.size === 0) {
    throw new Error("No authorized roots configured");
  }

  const allowed = Array.from(roots).some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error("project_dir is not within an authorized root");
  }

  return canonical;
}

function validateServerName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("server_name is required");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("server_name must not start with '-'");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("server_name must be alphanumeric with '-' or '_'");
  }
  return trimmed;
}

function execOpencode(program: string, args: string[], cwd: string) {
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      program,
      args,
      {
        cwd,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
          ...bunEnvOverrides(),
          PATH: pathEnv(),
        },
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(new Error(`Failed to run ${args.join(" ")}: ${error.message}`));
          return;
        }

        resolve({
          ok: !error,
          status: typeof (error as { code?: unknown } | null)?.code === "number" ? Number((error as { code: number }).code) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

export function createOpencodeAdminService() {
  return {
    async dbMigrate(input: {
      projectDir: string;
      preferSidecar?: boolean;
      opencodeBinPath?: string | null;
    }) {
      const projectDir = await validateProjectDir(input.projectDir);
      const program = resolveEnginePath(input.preferSidecar ?? false, input.opencodeBinPath ?? null);
      if (!program) {
        throw new Error("OpenCode CLI not found.");
      }
      return execOpencode(program, ["db", "migrate"], projectDir);
    },

    async mcpAuth(input: { projectDir: string; serverName: string }) {
      const projectDir = await validateProjectDir(input.projectDir);
      const serverName = validateServerName(input.serverName);
      const program = resolveEnginePath(true, null);
      if (!program) {
        throw new Error("OpenCode CLI not found.");
      }
      return execOpencode(program, ["mcp", "auth", serverName], projectDir);
    },
  };
}

export type OpencodeAdminService = ReturnType<typeof createOpencodeAdminService>;

export function registerOpencodeAdminIpc(service: OpencodeAdminService) {
  ipcMain.handle(
    IPC_CHANNELS.opencode("dbMigrate"),
    (_event, input: { projectDir: string; preferSidecar?: boolean; opencodeBinPath?: string | null }) =>
      service.dbMigrate(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.opencode("mcpAuth"),
    (_event, input: { projectDir: string; serverName: string }) => service.mcpAuth(input),
  );
}
