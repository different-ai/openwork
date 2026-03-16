import { app, BrowserWindow, type Rectangle } from "electron";
import path from "node:path";

const MAIN_WINDOW_WIDTH = 1180;
const MAIN_WINDOW_HEIGHT = 820;
const DEV_RENDERER_URL = "http://localhost:5173";
let mainWindowDecorations = true;

type RendererTarget =
  | { kind: "url"; value: string }
  | { kind: "file"; value: string };

type CreateMainWindowOptions = {
  bounds?: Rectangle;
  decorations?: boolean;
};

function resolveSiblingPath(tsRelativePath: string, jsRelativePath: string) {
  const currentFile = __filename;
  const currentDir = __dirname;
  const relativePath = currentFile.endsWith(".ts") ? tsRelativePath : jsRelativePath;
  return path.resolve(currentDir, relativePath);
}

export function resolvePreloadPath() {
  return resolveSiblingPath("../preload.ts", "./preload.cjs");
}

export function resolveRendererTarget(): RendererTarget {
  const configuredDevUrl =
    process.env.OPENWORK_RENDERER_URL?.trim() || process.env.ELECTRON_RENDERER_URL?.trim() || DEV_RENDERER_URL;

  if (!app.isPackaged) {
    return { kind: "url", value: configuredDevUrl };
  }

  return {
    kind: "file",
    value: path.join(process.resourcesPath, "app-dist", "index.html"),
  };
}

export function createMainWindow() {
  return createConfiguredMainWindow();
}

function createConfiguredMainWindow(options: CreateMainWindowOptions = {}) {
  const bounds = options.bounds;
  const decorations = options.decorations ?? mainWindowDecorations;
  mainWindowDecorations = decorations;

  return new BrowserWindow({
    title: app.isPackaged ? "OpenWork" : "OpenWork - Dev",
    width: bounds?.width ?? MAIN_WINDOW_WIDTH,
    height: bounds?.height ?? MAIN_WINDOW_HEIGHT,
    x: bounds?.x,
    y: bounds?.y,
    resizable: true,
    frame: decorations,
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

export function getMainWindowDecorations() {
  return mainWindowDecorations;
}

export async function replaceMainWindow(currentWindow: BrowserWindow, decorations: boolean) {
  const currentUrl = currentWindow.webContents.getURL();
  const bounds = currentWindow.getBounds();
  const wasFocused = currentWindow.isFocused();
  const replacement = createConfiguredMainWindow({ bounds, decorations });

  if (currentUrl && currentUrl !== "about:blank") {
    await replacement.loadURL(currentUrl);
  } else {
    await loadMainWindow(replacement);
  }

  currentWindow.destroy();

  if (wasFocused) {
    replacement.focus();
  }

  return replacement;
}
