import { ipcMain, type BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { getMainWindowDecorations, replaceMainWindow } from "../window/main-window";

type WindowServiceOptions = {
  getMainWindow: () => BrowserWindow | null;
  setMainWindow: (window: BrowserWindow | null) => void;
};

function requireMainWindow(getMainWindow: () => BrowserWindow | null) {
  const window = getMainWindow();
  if (!window) {
    throw new Error("Main window not found");
  }
  return window;
}

function normalizeZoomFactor(factor: number) {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("factor must be a positive number");
  }

  return Math.round(factor * 100) / 100;
}

export function createWindowService(options: WindowServiceOptions) {
  return {
    getZoomFactor() {
      return requireMainWindow(options.getMainWindow).webContents.getZoomFactor();
    },

    setZoomFactor(input: { factor: number }) {
      const factor = normalizeZoomFactor(input.factor);
      const window = requireMainWindow(options.getMainWindow);
      window.webContents.setZoomFactor(factor);
      return window.webContents.getZoomFactor();
    },

    async setDecorations(input: { decorations: boolean }) {
      const window = requireMainWindow(options.getMainWindow);
      if (getMainWindowDecorations() === input.decorations) {
        return;
      }

      const replacement = await replaceMainWindow(window, input.decorations);
      options.setMainWindow(replacement);
    },
  };
}

export type WindowService = ReturnType<typeof createWindowService>;

export function registerWindowIpc(service: WindowService) {
  ipcMain.handle(IPC_CHANNELS.window("getZoomFactor"), () => service.getZoomFactor());
  ipcMain.handle(IPC_CHANNELS.window("setZoomFactor"), (_event, input: { factor: number }) => service.setZoomFactor(input));
  ipcMain.handle(IPC_CHANNELS.window("setDecorations"), (_event, input: { decorations: boolean }) =>
    service.setDecorations(input),
  );
}
