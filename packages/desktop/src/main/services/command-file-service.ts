import { ipcMain } from "electron";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecResult } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";
import { sanitizeCommandName, serializeCommandFrontmatter } from "./workspace-files";

type CommandDraft = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

function resolveCommandsDir(scope: "workspace" | "global", projectDir: string) {
  if (scope === "workspace") {
    if (!projectDir.trim()) {
      throw new Error("projectDir is required");
    }

    return path.join(projectDir, ".opencode", "commands");
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "opencode", "commands");
  }

  const home = process.env.HOME?.trim();
  if (home) {
    return path.join(home, ".config", "opencode", "commands");
  }

  throw new Error("Unable to resolve config directory");
}

export function createCommandFileService() {
  return {
    async list(input: { scope: "workspace" | "global"; projectDir: string }) {
      const dir = resolveCommandsDir(input.scope, input.projectDir.trim());
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => entry.name.replace(/\.md$/, ""))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw new Error(`Failed to read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async write(input: {
      scope: "workspace" | "global";
      projectDir: string;
      command: CommandDraft;
    }): Promise<ExecResult> {
      const safeName = sanitizeCommandName(input.command.name);
      if (!safeName) {
        throw new Error("command.name is required");
      }

      const dir = resolveCommandsDir(input.scope, input.projectDir.trim());
      await mkdir(dir, { recursive: true });

      const filePath = path.join(dir, `${safeName}.md`);
      const serialized = serializeCommandFrontmatter({
        ...input.command,
        name: safeName,
      });
      await writeFile(filePath, serialized, "utf8");

      return {
        ok: true,
        status: 0,
        stdout: `Wrote ${filePath}`,
        stderr: "",
      };
    },

    async delete(input: {
      scope: "workspace" | "global";
      projectDir: string;
      name: string;
    }): Promise<ExecResult> {
      const safeName = sanitizeCommandName(input.name);
      if (!safeName) {
        throw new Error("name is required");
      }

      const dir = resolveCommandsDir(input.scope, input.projectDir.trim());
      const filePath = path.join(dir, `${safeName}.md`);
      await rm(filePath, { force: true });

      return {
        ok: true,
        status: 0,
        stdout: `Deleted ${filePath}`,
        stderr: "",
      };
    },
  };
}

export type CommandFileService = ReturnType<typeof createCommandFileService>;

export function registerCommandFileIpc(service: CommandFileService) {
  ipcMain.handle(IPC_CHANNELS.commandFiles("list"), (_event, input: { scope: "workspace" | "global"; projectDir: string }) =>
    service.list(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.commandFiles("write"),
    (_event, input: { scope: "workspace" | "global"; projectDir: string; command: CommandDraft }) =>
      service.write(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.commandFiles("delete"),
    (_event, input: { scope: "workspace" | "global"; projectDir: string; name: string }) => service.delete(input),
  );
}
