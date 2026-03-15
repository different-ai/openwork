import { app } from "electron";
import { createDesktopEventBus } from "./services/event-bus";

export type MainProcessContext = {
  eventBus: ReturnType<typeof createDesktopEventBus>;
  startedAt: number;
};

let mainProcessContext: MainProcessContext | null = null;

export function createMainProcessContext(): MainProcessContext {
  return {
    eventBus: createDesktopEventBus(),
    startedAt: Date.now(),
  };
}

export async function bootstrapMainProcess() {
  if (mainProcessContext) {
    return mainProcessContext;
  }

  const context = createMainProcessContext();

  app.on("activate", () => {
    // BrowserWindow creation gets wired in the next scaffold step.
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

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
