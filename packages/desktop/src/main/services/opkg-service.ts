import { ipcMain } from "electron";
import { execFile } from "node:child_process";

import type { ExecResult } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

function runCaptureOptional(command: string, args: string[], projectDir: string): Promise<ExecResult | null> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: projectDir,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120000,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve(null);
          return;
        }

        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(new Error(`Failed to run ${command}: ${error.message}`));
          return;
        }

        const status = typeof (error as { code?: unknown } | null)?.code === "number"
          ? Number((error as { code: number }).code)
          : 0;
        resolve({
          ok: !error,
          status,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

export function createOpkgService() {
  return {
    async install(input: { projectDir: string; package: string }): Promise<ExecResult> {
      const projectDir = input.projectDir.trim();
      if (!projectDir) {
        throw new Error("projectDir is required");
      }

      const packageName = input.package.trim();
      if (!packageName) {
        throw new Error("package is required");
      }

      const commands: Array<[string, string[]]> = [
        ["opkg", ["install", packageName]],
        ["openpackage", ["install", packageName]],
        ["pnpm", ["dlx", "opkg", "install", packageName]],
        ["npx", ["opkg", "install", packageName]],
      ];

      for (const [command, args] of commands) {
        const result = await runCaptureOptional(command, args, projectDir);
        if (result) {
          return result;
        }
      }

      return {
        ok: false,
        status: -1,
        stdout: "",
        stderr:
          "OpenPackage CLI not found. Install with `npm install -g opkg` (or `openpackage`), or ensure pnpm/npx is available.",
      };
    },
  };
}

export type OpkgService = ReturnType<typeof createOpkgService>;

export function registerOpkgIpc(service: OpkgService) {
  ipcMain.handle(IPC_CHANNELS.packages("opkgInstall"), (_event, input: { projectDir: string; package: string }) =>
    service.install(input),
  );
}
