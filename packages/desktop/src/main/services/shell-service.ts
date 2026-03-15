import { ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { validatePathInput, validateUrlInput } from "../ipc/validation";

const EXTERNAL_URL_PROTOCOLS = ["http:", "https:", "mailto:", "openwork:", "openwork-dev:"] as const;

export function createShellService() {
  return {
    async openExternal(input: { url: string }) {
      const url = validateUrlInput(input.url, {
        label: "url",
        protocols: EXTERNAL_URL_PROTOCOLS,
      });
      await shell.openExternal(url);
    },

    async openPath(input: { path: string }) {
      const targetPath = validatePathInput(input.path, {
        label: "path",
        allowRelative: false,
      });
      const error = await shell.openPath(targetPath);
      if (error) {
        throw new Error(error);
      }
    },

    async revealItemInDir(input: { path: string }) {
      const targetPath = validatePathInput(input.path, {
        label: "path",
        allowRelative: false,
      });
      shell.showItemInFolder(targetPath);
    },
  };
}

export type ShellService = ReturnType<typeof createShellService>;

export function registerShellIpc(service: ShellService) {
  ipcMain.handle(IPC_CHANNELS.shell("openExternal"), (_event, input: { url: string }) => service.openExternal(input));
  ipcMain.handle(IPC_CHANNELS.shell("openPath"), (_event, input: { path: string }) => service.openPath(input));
  ipcMain.handle(IPC_CHANNELS.shell("revealItemInDir"), (_event, input: { path: string }) =>
    service.revealItemInDir(input),
  );
}
