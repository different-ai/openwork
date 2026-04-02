import { app, BrowserWindow, ipcMain, shell } from "electron";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.LABS_RENDERER_URL || "";
const localUrl = "http://127.0.0.1:4096";

let mainWindow = null;
let local = null;
let boot = null;

async function ensureLocalServer() {
  if (local) {
    return { baseUrl: local.url };
  }

  if (boot) {
    return boot;
  }

  boot = (async () => {
    try {
      const client = createOpencodeClient({ baseUrl: localUrl });
      await client.global.health();
      return { baseUrl: localUrl };
    } catch {
      const runtime = await createOpencode();
      local = {
        url: runtime.server.url,
        close: () => runtime.server.close(),
      };
      return { baseUrl: runtime.server.url };
    }
  })();

  try {
    return await boot;
  } finally {
    boot = null;
  }
}

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
  return ensureLocalServer();
});

app.whenReady().then(async () => {
  try {
    await ensureLocalServer();
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
  local?.close();
  local = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
