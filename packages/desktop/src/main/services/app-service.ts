import { app, ipcMain, type App } from "electron";
import path from "node:path";
import type { AppBuildInfo } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

type AppServiceOptions = {
  app: Pick<App, "exit" | "getPath" | "getVersion" | "relaunch">;
  beforeExit?: () => Promise<void> | void;
};

function envTruthy(key: string) {
  const value = process.env[key]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function optionalEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveOrchestratorDataDir(electronApp: Pick<App, "getPath">) {
  const configured = optionalEnv(process.env.OPENWORK_DATA_DIR);
  if (configured) {
    return configured;
  }

  return path.join(electronApp.getPath("home"), ".openwork", "openwork-orchestrator");
}

async function removeIfExists(targetPath: string) {
  const { rm } = await import("node:fs/promises");
  await rm(targetPath, { force: true, recursive: true });
}

export function createAppService(options: AppServiceOptions) {
  return {
    getVersion() {
      return options.app.getVersion();
    },

    getBuildInfo(): AppBuildInfo {
      return {
        version: options.app.getVersion(),
        gitSha: optionalEnv(process.env.OPENWORK_GIT_SHA),
        buildEpoch: optionalEnv(process.env.OPENWORK_BUILD_EPOCH),
        openworkDevMode: envTruthy("OPENWORK_DEV_MODE"),
      };
    },

    async relaunch() {
      options.app.relaunch();
      options.app.exit(0);
    },

    async nukeDevConfigAndExit() {
      if (!envTruthy("OPENWORK_DEV_MODE")) {
        throw new Error("OpenCode dev mode is not enabled.");
      }

      await options.beforeExit?.();

      const desktopDevDir = path.join(options.app.getPath("userData"), "opencode-dev");
      const orchestratorDataDir = resolveOrchestratorDataDir(options.app);
      const orchestratorDevDir = path.join(orchestratorDataDir, "opencode-dev");

      await removeIfExists(desktopDevDir);
      await removeIfExists(orchestratorDevDir);
      await removeIfExists(path.join(orchestratorDataDir, "openwork-orchestrator-state.json"));
      await removeIfExists(path.join(orchestratorDataDir, "openwork-orchestrator-auth.json"));

      options.app.exit(0);
    },
  };
}

export type AppService = ReturnType<typeof createAppService>;

export function registerAppIpc(service: AppService) {
  ipcMain.handle(IPC_CHANNELS.app("getVersion"), () => service.getVersion());
  ipcMain.handle(IPC_CHANNELS.app("getBuildInfo"), () => service.getBuildInfo());
  ipcMain.handle(IPC_CHANNELS.app("relaunch"), () => service.relaunch());
  ipcMain.handle(IPC_CHANNELS.app("nukeDevConfigAndExit"), () => service.nukeDevConfigAndExit());
}

export function createDefaultAppService() {
  return createAppService({ app });
}
