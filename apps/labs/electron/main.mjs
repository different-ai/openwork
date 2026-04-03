import electron from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { labsKernel } from "./kernel.mjs";

const { app, BrowserWindow, ipcMain, shell } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.LABS_RENDERER_URL || "";

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#141211",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl).catch(() => undefined);
  } else {
    mainWindow
      .loadFile(path.join(__dirname, "..", "dist", "index.html"))
      .catch(() => undefined);
  }
}

ipcMain.handle("labs:ensure-local-server", async () => {
  return labsKernel.ensureLocalServer();
});

ipcMain.handle("labs:pick-repo-directory", async () => {
  const result = await electron.dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Choose workspace repository",
  });
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
});

ipcMain.handle("labs:ensure-workspace", async (_event, workspace) => {
  return labsKernel.ensureWorkspace(workspace);
});

ipcMain.handle("labs:refresh-workspace", async (_event, workspaceId) => {
  return labsKernel.refreshWorkspace(workspaceId);
});

ipcMain.handle("labs:remove-workspace", async (_event, workspaceId) => {
  labsKernel.removeWorkspace(workspaceId);
  return true;
});

ipcMain.handle("labs:get-session-messages", async (_event, payload) => {
  return labsKernel.getSessionMessages(payload.workspaceId, payload.sessionId);
});

ipcMain.handle("labs:create-session", async (_event, payload) => {
  return labsKernel.createSession(payload.workspaceId, payload.options ?? {});
});

ipcMain.handle("labs:send-prompt", async (_event, payload) => {
  return labsKernel.sendPrompt(payload.workspaceId, payload.sessionId ?? null, payload.prompt);
});

ipcMain.handle("labs:abort-session", async (_event, payload) => {
  await labsKernel.abortSession(payload.workspaceId, payload.sessionId ?? null);
  return true;
});

app.whenReady().then(async () => {
  try {
    await labsKernel.ensureLocalServer();
  } catch (error) {
    console.error("Failed to start local OpenCode server", error);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  labsKernel.teardownKernel();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
