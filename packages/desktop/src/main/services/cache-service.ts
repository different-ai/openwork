import { app, ipcMain } from "electron";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CacheResetResult } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

type CacheServiceOptions = {
  stopHostServices?: () => void | Promise<void>;
};

function resolveOrchestratorDataDir() {
  const configured = process.env.OPENWORK_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }

  return path.join(os.homedir(), ".openwork", "openwork-orchestrator");
}

function opencodeCacheCandidates() {
  const candidates: string[] = [];
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome) {
    candidates.push(path.join(xdgCacheHome, "opencode"));
  }

  const home = os.homedir();
  candidates.push(path.join(home, ".cache", "opencode"));
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Caches", "opencode"));
  }
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA?.trim()) {
      candidates.push(path.join(process.env.LOCALAPPDATA.trim(), "opencode"));
    }
    if (process.env.APPDATA?.trim()) {
      candidates.push(path.join(process.env.APPDATA.trim(), "opencode"));
    }
  }

  return Array.from(new Set(candidates));
}

async function removePathIfExists(targetPath: string) {
  await rm(targetPath, { recursive: true, force: true });
}

export function createCacheService(options: CacheServiceOptions = {}) {
  return {
    async resetOpenworkState(input: { mode: "onboarding" | "all" }) {
      if (input.mode !== "onboarding" && input.mode !== "all") {
        throw new Error("mode must be 'onboarding' or 'all'");
      }

      await options.stopHostServices?.();

      const paths = [app.getPath("sessionData"), app.getPath("userData")];
      if (input.mode === "all") {
        paths.push(resolveOrchestratorDataDir());
      }

      for (const targetPath of Array.from(new Set(paths.filter(Boolean)))) {
        await removePathIfExists(targetPath);
      }
    },

    async resetOpencodeCache(): Promise<CacheResetResult> {
      const removed: string[] = [];
      const missing: string[] = [];
      const errors: string[] = [];

      for (const targetPath of opencodeCacheCandidates()) {
        try {
          await rm(targetPath, { recursive: true, force: false });
          removed.push(targetPath);
        } catch (error) {
          const errno = error as NodeJS.ErrnoException;
          if (errno.code === "ENOENT") {
            missing.push(targetPath);
            continue;
          }
          errors.push(`Failed to remove ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return { removed, missing, errors };
    },
  };
}

export type CacheService = ReturnType<typeof createCacheService>;

export function registerCacheIpc(service: CacheService) {
  ipcMain.handle(IPC_CHANNELS.cache("resetOpenworkState"), (_event, input: { mode: "onboarding" | "all" }) =>
    service.resetOpenworkState(input),
  );
  ipcMain.handle(IPC_CHANNELS.cache("resetOpencodeCache"), () => service.resetOpencodeCache());
}
