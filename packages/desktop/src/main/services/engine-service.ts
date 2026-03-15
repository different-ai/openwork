import { ipcMain } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineDoctorResult } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

function opencodeExecutableName() {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function opencodeCmdName() {
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

function truncateOutput(value: string, max = 4000) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
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
        if (inline === "ipv4first" || inline === "verbatim") {
          kept.push(token);
        } else {
          changed = true;
        }
        continue;
      }

      if (token === "--dns-result-order") {
        const next = tokens[index + 1];
        if (next === "ipv4first" || next === "verbatim") {
          kept.push(token, next);
        } else {
          changed = true;
        }
        index += 1;
        continue;
      }

      kept.push(token);
    }

    return changed ? kept.join(" ") : null;
  };

  for (const key of ["BUN_OPTIONS", "NODE_OPTIONS"] as const) {
    const value = process.env[key];
    if (!value) {
      continue;
    }
    const sanitized = sanitize(value);
    if (sanitized) {
      overrides[key] = sanitized;
    }
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
    if (process.env.LOCALAPPDATA) {
      paths.push(path.join(process.env.LOCALAPPDATA, "pnpm"));
    }
    if (process.env.APPDATA) {
      paths.push(path.join(process.env.APPDATA, "npm"));
    }
  }

  return paths.filter((entry) => existsSync(entry));
}

function pathEnvWithCommonTools() {
  const entries = [...commonToolPaths(), ...(process.env.PATH?.split(path.delimiter) ?? [])];
  return Array.from(new Set(entries.filter(Boolean))).join(path.delimiter);
}

function execCapture(command: string, args: string[]) {
  return new Promise<{ ok: boolean; status: number | null; stdout: string | null; stderr: string | null }>((resolve) => {
    execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          ...bunEnvOverrides(),
          PATH: pathEnvWithCommonTools(),
        },
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          status: typeof (error as { code?: unknown } | null)?.code === "number" ? Number((error as { code: number }).code) : 0,
          stdout: stdout?.trim() ? truncateOutput(stdout.trim()) : null,
          stderr: stderr?.trim() ? truncateOutput(stderr.trim()) : null,
        });
      },
    );
  });
}

function resolveInPath(name: string) {
  const pathEntries = pathEnvWithCommonTools().split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function candidateOpencodePaths() {
  const home = os.homedir();
  const candidates = [path.join(home, ".opencode", "bin", opencodeExecutableName())];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "npm", opencodeExecutableName()));
      candidates.push(path.join(process.env.APPDATA, "npm", opencodeCmdName()));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "npm", opencodeExecutableName()));
      candidates.push(path.join(process.env.LOCALAPPDATA, "npm", opencodeCmdName()));
      candidates.push(path.join(process.env.LOCALAPPDATA, "OpenCode", opencodeExecutableName()));
    }
    candidates.push(path.join(home, "scoop", "shims", opencodeExecutableName()));
    candidates.push(path.join(home, "scoop", "shims", opencodeCmdName()));
    candidates.push(path.join("C:\\ProgramData\\chocolatey\\bin", opencodeExecutableName()));
    candidates.push(path.join("C:\\ProgramData\\chocolatey\\bin", opencodeCmdName()));
  } else {
    candidates.push(path.join("/opt/homebrew/bin", opencodeExecutableName()));
    candidates.push(path.join("/usr/local/bin", opencodeExecutableName()));
    candidates.push(path.join("/usr/bin", opencodeExecutableName()));
  }
  return candidates;
}

function resolveSidecarCandidate(preferSidecar: boolean) {
  if (!preferSidecar) {
    return { resolved: null as string | null, notes: [] as string[] };
  }

  const currentFile = fileURLToPath(import.meta.url);
  const sourceSidecarDir = path.resolve(path.dirname(currentFile), "../../src-tauri/sidecars");
  const candidates = [
    path.join(path.dirname(process.execPath), opencodeExecutableName()),
    path.join(process.resourcesPath || "", "sidecars", opencodeExecutableName()),
    path.join(process.resourcesPath || "", opencodeExecutableName()),
    path.join(sourceSidecarDir, opencodeExecutableName()),
  ].filter(Boolean);

  const notes: string[] = [];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      notes.push(`Using bundled sidecar: ${candidate}`);
      return { resolved: candidate, notes };
    }
    if (candidate) {
      notes.push(`Sidecar missing: ${candidate}`);
    }
  }

  return { resolved: null, notes };
}

function resolveEnginePath(preferSidecar: boolean, opencodeBinPath?: string | null) {
  const notes: string[] = [];
  const customPath = opencodeBinPath?.trim() || process.env.OPENCODE_BIN_PATH?.trim();
  if (customPath) {
    if (existsSync(customPath)) {
      notes.push(`Using OPENCODE_BIN_PATH: ${customPath}`);
      return { resolved: customPath, inPath: false, notes };
    }
    notes.push(`OPENCODE_BIN_PATH set but missing: ${customPath}`);
  }

  const sidecar = resolveSidecarCandidate(preferSidecar);
  notes.push(...sidecar.notes);
  if (sidecar.resolved) {
    return { resolved: sidecar.resolved, inPath: false, notes };
  }

  const inPath = resolveInPath(opencodeExecutableName()) || (process.platform === "win32" ? resolveInPath(opencodeCmdName()) : null);
  if (inPath) {
    notes.push(`Found in PATH: ${inPath}`);
    return { resolved: inPath, inPath: true, notes };
  }
  notes.push("Not found on PATH");

  for (const candidate of candidateOpencodePaths()) {
    if (existsSync(candidate)) {
      notes.push(`Found at ${candidate}`);
      return { resolved: candidate, inPath: false, notes };
    }
    notes.push(`Missing: ${candidate}`);
  }

  return { resolved: null, inPath: false, notes };
}

export function createEngineService() {
  return {
    async doctor(input?: { preferSidecar?: boolean; opencodeBinPath?: string | null }): Promise<EngineDoctorResult> {
      const resolved = resolveEnginePath(input?.preferSidecar ?? false, input?.opencodeBinPath ?? null);
      if (!resolved.resolved) {
        return {
          found: false,
          inPath: resolved.inPath,
          resolvedPath: null,
          version: null,
          supportsServe: false,
          notes: resolved.notes,
          serveHelpStatus: null,
          serveHelpStdout: null,
          serveHelpStderr: null,
        };
      }

      const versionResult = await execCapture(resolved.resolved, ["--version"]);
      const serveHelp = await execCapture(resolved.resolved, ["serve", "--help"]);
      return {
        found: true,
        inPath: resolved.inPath,
        resolvedPath: resolved.resolved,
        version: versionResult.stdout || versionResult.stderr,
        supportsServe: serveHelp.ok,
        notes: resolved.notes,
        serveHelpStatus: serveHelp.status,
        serveHelpStdout: serveHelp.stdout,
        serveHelpStderr: serveHelp.stderr,
      };
    },
  };
}

export type EngineService = ReturnType<typeof createEngineService>;

export function registerEngineIpc(service: EngineService) {
  ipcMain.handle(IPC_CHANNELS.engine("doctor"), (_event, input?: { preferSidecar?: boolean; opencodeBinPath?: string | null }) =>
    service.doctor(input),
  );
}
