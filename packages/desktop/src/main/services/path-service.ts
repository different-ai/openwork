import { app, ipcMain } from "electron";
import path from "node:path";

import { IPC_CHANNELS } from "../ipc/channels";

function validatePathLike(value: string, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  if (value.includes("\0")) {
    throw new Error(`${label} must not contain null bytes`);
  }

  return value;
}

export function createPathService() {
  return {
    home() {
      return app.getPath("home");
    },

    downloads() {
      return app.getPath("downloads");
    },

    join(input: { segments: string[] }) {
      if (!Array.isArray(input.segments)) {
        throw new Error("segments must be an array");
      }

      if (input.segments.length === 0) {
        return "";
      }

      const segments = input.segments.map((segment, index) => validatePathLike(segment, `segments[${index}]`));
      return path.join(...segments);
    },

    expandUser(input: { path: string }) {
      const rawPath = validatePathLike(input.path, "path");
      const homePath = app.getPath("home");

      if (rawPath === "~") {
        return homePath;
      }

      if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
        return path.join(homePath, rawPath.slice(2));
      }

      return rawPath;
    },
  };
}

export type PathService = ReturnType<typeof createPathService>;

export function registerPathIpc(service: PathService) {
  ipcMain.handle(IPC_CHANNELS.paths("home"), () => service.home());
  ipcMain.handle(IPC_CHANNELS.paths("downloads"), () => service.downloads());
  ipcMain.handle(IPC_CHANNELS.paths("join"), (_event, input: { segments: string[] }) => service.join(input));
  ipcMain.handle(IPC_CHANNELS.paths("expandUser"), (_event, input: { path: string }) => service.expandUser(input));
}
