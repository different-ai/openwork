import { app, ipcMain } from "electron";

import type { DesktopRuntimeInfo } from "../../../../app/src/app/lib/openwork-desktop";
import { IPC_CHANNELS } from "../ipc/channels";

export function createRuntimeService() {
  return {
    getInfo(): DesktopRuntimeInfo {
      return {
        contractVersion: 1,
        runtime: "electron",
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        isDev: !app.isPackaged || process.env.OPENWORK_DEV_MODE === "1",
      };
    },
  };
}

export type RuntimeService = ReturnType<typeof createRuntimeService>;

export function registerRuntimeIpc(service: RuntimeService) {
  ipcMain.handle(IPC_CHANNELS.runtime("getInfo"), () => service.getInfo());
}
