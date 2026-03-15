import { app, type BrowserWindow } from "electron";
import { createDesktopEventBus } from "./services/event-bus";
import { createDefaultAppService, registerAppIpc } from "./services/app-service";
import { createCommandFileService, registerCommandFileIpc } from "./services/command-file-service";
import { createConfigService, registerConfigIpc } from "./services/config-service";
import { createCacheService, registerCacheIpc } from "./services/cache-service";
import {
  createDefaultDeepLinkService,
  registerDeepLinkIpc,
  type DeepLinkService,
} from "./services/deep-link-service";
import { createDialogService, registerDialogIpc } from "./services/dialog-service";
import { createEngineService, registerEngineIpc } from "./services/engine-service";
import { createOrchestratorService, registerOrchestratorIpc } from "./services/orchestrator-service";
import { createOpenworkServerService, registerOpenworkServerIpc } from "./services/openwork-server-service";
import { createObsidianService, registerObsidianIpc } from "./services/obsidian-service";
import { createPathService, registerPathIpc } from "./services/path-service";
import { createRouterService, registerRouterIpc } from "./services/router-service";
import { createSchedulerService, registerSchedulerIpc } from "./services/scheduler-service";
import { createOpkgService, registerOpkgIpc } from "./services/opkg-service";
import { createShellService, registerShellIpc } from "./services/shell-service";
import { createSkillService, registerSkillIpc } from "./services/skill-service";
import { createUpdateService, registerUpdateIpc } from "./services/update-service";
import { createWorkspaceService, registerWorkspaceIpc } from "./services/workspace-service";
import { createWindowService, registerWindowIpc } from "./services/window-service";
import { createMainWindow, hasOpenWindows, loadMainWindow } from "./window/main-window";

export type MainProcessContext = {
  eventBus: ReturnType<typeof createDesktopEventBus>;
  mainWindow: BrowserWindow | null;
  startedAt: number;
};

let mainProcessContext: MainProcessContext | null = null;
let deepLinkService: DeepLinkService | null = null;
let mainProcessBootstrapped = false;

function getOrCreateMainProcessContext() {
  if (!mainProcessContext) {
    mainProcessContext = createMainProcessContext();
  }

  return mainProcessContext;
}

function focusMainWindow(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
}

function getOrCreateDeepLinkService() {
  if (deepLinkService) {
    return deepLinkService;
  }

  const context = getOrCreateMainProcessContext();
  deepLinkService = createDefaultDeepLinkService({
    emitDeepLink: (event) => {
      context.eventBus.emit("deepLinkOpen", event);
    },
    focusMainWindow: () => focusMainWindow(context.mainWindow),
  });

  return deepLinkService;
}

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
  const context = getOrCreateMainProcessContext();
  if (mainProcessBootstrapped) {
    return context;
  }

  const activeDeepLinkService = getOrCreateDeepLinkService();
  const engineService = createEngineService();
  const openworkServerService = createOpenworkServerService({
    getEngineInfo: () => engineService.info(),
  });
  const routerService = createRouterService();
  const stopHostServices = () => {
    engineService.cleanupOnQuit();
    openworkServerService.cleanupOnQuit();
    routerService.cleanupOnQuit?.();
  };
  registerAppIpc(createDefaultAppService());
  registerDeepLinkIpc(activeDeepLinkService);
  registerEngineIpc(engineService);
  registerWindowIpc(
    createWindowService({
      getMainWindow: () => context.mainWindow,
      setMainWindow: (window) => {
        context.mainWindow = window;
      },
    }),
  );
  registerDialogIpc(
    createDialogService({
      getMainWindow: () => context.mainWindow,
    }),
  );
  registerPathIpc(createPathService());
  registerOpkgIpc(createOpkgService());
  registerShellIpc(createShellService());
  registerSkillIpc(createSkillService());
  registerUpdateIpc(
    createUpdateService({
      emitStatus: (event) => {
        context.eventBus.emit("updateStatus", event);
      },
    }),
  );
  registerCommandFileIpc(createCommandFileService());
  registerConfigIpc(createConfigService());
  registerObsidianIpc(createObsidianService());
  registerOrchestratorIpc(
    createOrchestratorService({
      emitSandboxProgress: (event) => {
        context.eventBus.emit("sandboxCreateProgress", event);
      },
    }),
  );
  registerOpenworkServerIpc(openworkServerService);
  registerRouterIpc(routerService);
  registerSchedulerIpc(createSchedulerService());
  registerCacheIpc(createCacheService({ stopHostServices }));
  registerWorkspaceIpc(createWorkspaceService());
  context.eventBus.registerRendererSink((event) => {
    const window = context.mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }

    window.webContents.send(event.channel, event.payload);
  });
  activeDeepLinkService.onReady();

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

  app.on("before-quit", () => {
    stopHostServices();
  });

  await openMainWindow(context);

  mainProcessBootstrapped = true;
  return context;
}

async function main() {
  const activeDeepLinkService = getOrCreateDeepLinkService();
  if (!activeDeepLinkService.initializeBeforeReady()) {
    app.quit();
    return null;
  }

  await app.whenReady();
  return bootstrapMainProcess();
}

void main().catch((error) => {
  console.error("[openwork-desktop] failed to bootstrap Electron main process", error);
  app.exit(1);
});
