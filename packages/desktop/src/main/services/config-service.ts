import { ipcMain } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecResult, OpencodeConfigFile } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

function resolveOpencodeConfigPath(scope: "project" | "global", projectDir: string) {
  if (scope === "project") {
    if (!projectDir.trim()) {
      throw new Error("projectDir is required");
    }

    const root = projectDir;
    const jsoncPath = path.join(root, "opencode.jsonc");
    const jsonPath = path.join(root, "opencode.json");
    if (existsSync(jsoncPath)) {
      return jsoncPath;
    }
    if (existsSync(jsonPath)) {
      return jsonPath;
    }
    return jsoncPath;
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const home = process.env.HOME?.trim();
  const base = xdgConfigHome ? xdgConfigHome : home ? path.join(home, ".config") : null;
  if (!base) {
    throw new Error("Unable to resolve config directory");
  }

  const root = path.join(base, "opencode");
  const jsoncPath = path.join(root, "opencode.jsonc");
  const jsonPath = path.join(root, "opencode.json");
  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
  }
  return jsoncPath;
}

export function createConfigService() {
  return {
    async readOpencode(input: { scope: "project" | "global"; projectDir: string }): Promise<OpencodeConfigFile> {
      const resolvedPath = resolveOpencodeConfigPath(input.scope, input.projectDir.trim());
      const exists = existsSync(resolvedPath);
      return {
        path: resolvedPath,
        exists,
        content: exists ? await readFile(resolvedPath, "utf8") : null,
      };
    },

    async writeOpencode(input: {
      scope: "project" | "global";
      projectDir: string;
      content: string;
    }): Promise<ExecResult> {
      const resolvedPath = resolveOpencodeConfigPath(input.scope, input.projectDir.trim());
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, input.content, "utf8");
      return {
        ok: true,
        status: 0,
        stdout: `Wrote ${resolvedPath}`,
        stderr: "",
      };
    },
  };
}

export type ConfigService = ReturnType<typeof createConfigService>;

export function registerConfigIpc(service: ConfigService) {
  ipcMain.handle(IPC_CHANNELS.config("readOpencode"), (_event, input: { scope: "project" | "global"; projectDir: string }) =>
    service.readOpencode(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.config("writeOpencode"),
    (_event, input: { scope: "project" | "global"; projectDir: string; content: string }) =>
      service.writeOpencode(input),
  );
}
