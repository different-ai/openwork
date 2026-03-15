import { app, type BrowserWindow } from "electron";
import { createDesktopEventBus } from "./services/event-bus";
import { createDefaultAppService, registerAppIpc } from "./services/app-service";
import { createMainWindow, hasOpenWindows, loadMainWindow } from "./window/main-window";

export type MainProcessContext = {
  eventBus: ReturnType<typeof createDesktopEventBus>;
  mainWindow: BrowserWindow | null;
  startedAt: number;
};

let mainProcessContext: MainProcessContext | null = null;

export function createMainProcessContext(): MainProcessContext {
  return {
    eventBus: createDesktopEventBus(),
    mainWindow: null,
    startedAt: Date.now(),
  };
}

async function openMainWindow(context: MainProcessContext) {
  const window = createMainWindow();
  context.mainWindow = window;

  window.on("closed", () => {
    if (context.mainWindow === window) {
      context.mainWindow = null;
    }
  });

  await loadMainWindow(window);
  return window;
}

export async function bootstrapMainProcess() {
  if (mainProcessContext) {
    return mainProcessContext;
  }

  const context = createMainProcessContext();
  registerAppIpc(createDefaultAppService());

  app.on("activate", () => {
    if (hasOpenWindows()) {
      return;
    }

    void openMainWindow(context);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  await openMainWindow(context);

  mainProcessContext = context;
  return context;
}

async function main() {
  await app.whenReady();
  return bootstrapMainProcess();
}

void main().catch((error) => {
  console.error("[openwork-desktop] failed to bootstrap Electron main process", error);
  app.exit(1);
});
