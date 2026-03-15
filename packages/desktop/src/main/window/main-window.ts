import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_WINDOW_WIDTH = 1180;
const MAIN_WINDOW_HEIGHT = 820;
const DEV_RENDERER_URL = "http://localhost:5173";

type RendererTarget =
  | { kind: "url"; value: string }
  | { kind: "file"; value: string };

function resolveSiblingPath(tsRelativePath: string, jsRelativePath: string) {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const relativePath = currentFile.endsWith(".ts") ? tsRelativePath : jsRelativePath;
  return path.resolve(currentDir, relativePath);
}

export function resolvePreloadPath() {
  return resolveSiblingPath("../preload.ts", "../preload.js");
}

export function resolveRendererTarget(): RendererTarget {
  const configuredDevUrl =
    process.env.OPENWORK_RENDERER_URL?.trim() || process.env.ELECTRON_RENDERER_URL?.trim() || DEV_RENDERER_URL;

  if (!app.isPackaged) {
    return { kind: "url", value: configuredDevUrl };
  }

  return {
    kind: "file",
    value: resolveSiblingPath("../../../../app/dist/index.html", "../../../app/dist/index.html"),
  };
}

export function createMainWindow() {
  return new BrowserWindow({
    title: app.isPackaged ? "OpenWork" : "OpenWork - Dev",
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    resizable: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export async function loadMainWindow(window: BrowserWindow) {
  const target = resolveRendererTarget();
  if (target.kind === "url") {
    await window.loadURL(target.value);
    return;
  }

  await window.loadFile(target.value);
}

export function hasOpenWindows() {
  return BrowserWindow.getAllWindows().length > 0;
}
