import { app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ObsidianMirrorFileContent } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

function obsidianCandidates() {
  if (process.platform !== "darwin") {
    return [] as string[];
  }

  const candidates = ["/Applications/Obsidian.app"];
  const home = process.env.HOME?.trim();
  if (home) {
    candidates.push(path.join(home, "Applications", "Obsidian.app"));
  }
  return candidates;
}

function sanitizeWorkspaceId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  let out = "";
  let lastDash = false;
  for (const ch of trimmed) {
    const normalized = /[A-Za-z0-9_]/.test(ch) ? ch.toLowerCase() : "-";
    if (normalized === "-") {
      if (lastDash) continue;
      out += normalized;
      lastDash = true;
      continue;
    }
    out += normalized;
    lastDash = false;
  }

  return out.replace(/^-+|-+$/g, "");
}

function normalizeMirrorRelativePath(filePath: string) {
  let value = filePath.trim().replace(/\\/g, "/");
  if (!value) {
    throw new Error("file_path is required");
  }

  while (value.startsWith("./")) {
    value = value.slice(2);
  }
  if (!value) {
    throw new Error("file_path is required");
  }

  const lower = value.toLowerCase();
  if (lower.startsWith("workspace/")) {
    value = value.slice("workspace/".length);
  } else if (lower.startsWith("/workspace/")) {
    value = value.replace(/^\/workspace\//i, "");
  }

  const isWindowsAbs = /^[A-Za-z]:\//.test(value);
  if (value.startsWith("/") || value.startsWith("~") || isWindowsAbs) {
    throw new Error("file_path must be worker-relative");
  }

  const parts = value.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("file_path is required");
  }

  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error("file_path must not contain '.' or '..' segments");
    }
  }

  return path.join(...parts);
}

function mirrorRootForWorkspace(workspaceId: string) {
  const key = sanitizeWorkspaceId(workspaceId);
  if (!key) {
    throw new Error("workspace_id must contain at least one alphanumeric character");
  }
  return path.join(app.getPath("userData"), "obsidian-mirror", key);
}

export function createObsidianService() {
  return {
    isAvailable() {
      return obsidianCandidates().some((candidate) => existsSync(candidate));
    },

    async open(input: { filePath: string }) {
      const trimmed = input.filePath.trim();
      if (!trimmed) {
        throw new Error("file_path is required");
      }
      const absolutePath = path.resolve(trimmed);
      if (!existsSync(absolutePath)) {
        throw new Error(`File does not exist: ${absolutePath}`);
      }

      if (process.platform !== "darwin") {
        throw new Error("Open in Obsidian is currently supported on macOS only.");
      }
      if (!this.isAvailable()) {
        throw new Error("Obsidian is not installed.");
      }

      await new Promise<void>((resolve, reject) => {
        execFile("open", ["-a", "Obsidian", absolutePath], { windowsHide: true }, (error) => {
          if (error) {
            reject(new Error(`Failed to launch Obsidian: ${error.message}`));
            return;
          }
          resolve();
        });
      });
    },

    async writeMirrorFile(input: { workspaceId: string; filePath: string; content: string }) {
      const workspaceId = input.workspaceId.trim();
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }

      const relativePath = normalizeMirrorRelativePath(input.filePath);
      const target = path.join(mirrorRootForWorkspace(workspaceId), relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
      return target;
    },

    async readMirrorFile(input: { workspaceId: string; filePath: string }): Promise<ObsidianMirrorFileContent> {
      const workspaceId = input.workspaceId.trim();
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }

      const relativePath = normalizeMirrorRelativePath(input.filePath);
      const target = path.join(mirrorRootForWorkspace(workspaceId), relativePath);
      if (!existsSync(target)) {
        return { exists: false, path: target, content: null, updatedAtMs: null };
      }

      const metadata = await stat(target);
      if (!metadata.isFile()) {
        throw new Error(`Mirror path is not a file: ${target}`);
      }

      return {
        exists: true,
        path: target,
        content: await readFile(target, "utf8"),
        updatedAtMs: metadata.mtimeMs ? Math.trunc(metadata.mtimeMs) : null,
      };
    },
  };
}

export type ObsidianService = ReturnType<typeof createObsidianService>;

export function registerObsidianIpc(service: ObsidianService) {
  ipcMain.handle(IPC_CHANNELS.obsidian("isAvailable"), () => service.isAvailable());
  ipcMain.handle(IPC_CHANNELS.obsidian("open"), (_event, input: { filePath: string }) => service.open(input));
  ipcMain.handle(
    IPC_CHANNELS.obsidian("writeMirrorFile"),
    (_event, input: { workspaceId: string; filePath: string; content: string }) => service.writeMirrorFile(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.obsidian("readMirrorFile"),
    (_event, input: { workspaceId: string; filePath: string }) => service.readMirrorFile(input),
  );
}
