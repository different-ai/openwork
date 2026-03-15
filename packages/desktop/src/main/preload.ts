import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  DesktopDeepLinkEvent,
  DesktopUnsubscribe,
  DesktopUpdateStatusEvent,
  OpenWorkDesktopAPI,
  ReloadRequiredEvent,
  SandboxCreateProgressEvent,
} from "../../../app/src/app/lib/openwork-desktop";
import type { AppBuildInfo } from "../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from "./ipc/channels";

const noopUnsubscribe: DesktopUnsubscribe = () => {};

function notImplemented<T extends (...args: any[]) => any>(name: string): T {
  return ((..._args: unknown[]) => {
    throw new Error(`[openworkDesktop] ${name} is not implemented yet`);
  }) as unknown as T;
}

function notImplementedSubscription<T>(name: string): (listener: (event: T) => void) => DesktopUnsubscribe {
  return (_listener: (event: T) => void) => {
    console.warn(`[openworkDesktop] ${name} subscription is not implemented yet`);
    return noopUnsubscribe;
  };
}

function invokeDesktopChannel<T>(channel: string, input?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, input) as Promise<T>;
}

function subscribeToDesktopEvent<T>(channel: string, listener: (event: T) => void): DesktopUnsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T) => {
    listener(payload);
  };

  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

export function createOpenworkDesktopBridge(): OpenWorkDesktopAPI {
  return {
    runtime: {
      getInfo: notImplemented("runtime.getInfo"),
    },
    app: {
      getVersion: () => invokeDesktopChannel<string>(IPC_CHANNELS.app("getVersion")),
      getBuildInfo: () => invokeDesktopChannel<AppBuildInfo>(IPC_CHANNELS.app("getBuildInfo")),
      relaunch: () => invokeDesktopChannel<void>(IPC_CHANNELS.app("relaunch")),
      nukeDevConfigAndExit: () => invokeDesktopChannel<void>(IPC_CHANNELS.app("nukeDevConfigAndExit")),
    },
    window: {
      setDecorations: (input) => invokeDesktopChannel<void>(IPC_CHANNELS.window("setDecorations"), input),
      getZoomFactor: () => invokeDesktopChannel<number>(IPC_CHANNELS.window("getZoomFactor")),
      setZoomFactor: (input) => invokeDesktopChannel<number>(IPC_CHANNELS.window("setZoomFactor"), input),
    },
    dialogs: {
      pickDirectory: (input) => invokeDesktopChannel<string | string[] | null>(IPC_CHANNELS.dialogs("pickDirectory"), input),
      pickFile: (input) => invokeDesktopChannel<string | string[] | null>(IPC_CHANNELS.dialogs("pickFile"), input),
      saveFile: (input) => invokeDesktopChannel<string | null>(IPC_CHANNELS.dialogs("saveFile"), input),
    },
    shell: {
      openExternal: (input) => invokeDesktopChannel<void>(IPC_CHANNELS.shell("openExternal"), input),
      openPath: (input) => invokeDesktopChannel<void>(IPC_CHANNELS.shell("openPath"), input),
      revealItemInDir: (input) => invokeDesktopChannel<void>(IPC_CHANNELS.shell("revealItemInDir"), input),
    },
    paths: {
      home: () => invokeDesktopChannel<string>(IPC_CHANNELS.paths("home")),
      downloads: () => invokeDesktopChannel<string>(IPC_CHANNELS.paths("downloads")),
      join: (input) => invokeDesktopChannel<string>(IPC_CHANNELS.paths("join"), input),
      expandUser: (input) => invokeDesktopChannel<string>(IPC_CHANNELS.paths("expandUser"), input),
    },
    deepLinks: {
      getPending: () => invokeDesktopChannel<string[]>(IPC_CHANNELS.deepLinks("getPending")),
      onOpen: (listener) => subscribeToDesktopEvent<DesktopDeepLinkEvent>(IPC_EVENT_CHANNELS.deepLinkOpen, listener),
    },
    updates: {
      getEnvironment: notImplemented("updates.getEnvironment"),
      check: notImplemented("updates.check"),
      download: notImplemented("updates.download"),
      installAndRelaunch: notImplemented("updates.installAndRelaunch"),
      onStatus: notImplementedSubscription<DesktopUpdateStatusEvent>("updates.onStatus"),
    },
    workspace: {
      bootstrap: notImplemented("workspace.bootstrap"),
      setActive: notImplemented("workspace.setActive"),
      create: notImplemented("workspace.create"),
      createRemote: notImplemented("workspace.createRemote"),
      updateRemote: notImplemented("workspace.updateRemote"),
      updateDisplayName: notImplemented("workspace.updateDisplayName"),
      forget: notImplemented("workspace.forget"),
      addAuthorizedRoot: notImplemented("workspace.addAuthorizedRoot"),
      openworkRead: notImplemented("workspace.openworkRead"),
      openworkWrite: notImplemented("workspace.openworkWrite"),
      exportConfig: notImplemented("workspace.exportConfig"),
      importConfig: notImplemented("workspace.importConfig"),
      onReloadRequired: notImplementedSubscription<ReloadRequiredEvent>("workspace.onReloadRequired"),
    },
    commandFiles: {
      list: notImplemented("commandFiles.list"),
      write: notImplemented("commandFiles.write"),
      delete: notImplemented("commandFiles.delete"),
    },
    config: {
      readOpencode: notImplemented("config.readOpencode"),
      writeOpencode: notImplemented("config.writeOpencode"),
    },
    skills: {
      listLocal: notImplemented("skills.listLocal"),
      readLocal: notImplemented("skills.readLocal"),
      writeLocal: notImplemented("skills.writeLocal"),
      installTemplate: notImplemented("skills.installTemplate"),
      uninstall: notImplemented("skills.uninstall"),
      importFromDirectory: notImplemented("skills.importFromDirectory"),
    },
    packages: {
      opkgInstall: notImplemented("packages.opkgInstall"),
    },
    engine: {
      info: notImplemented("engine.info"),
      start: notImplemented("engine.start"),
      stop: notImplemented("engine.stop"),
      restart: notImplemented("engine.restart"),
      doctor: notImplemented("engine.doctor"),
      install: notImplemented("engine.install"),
    },
    orchestrator: {
      status: notImplemented("orchestrator.status"),
      activateWorkspace: notImplemented("orchestrator.activateWorkspace"),
      disposeInstance: notImplemented("orchestrator.disposeInstance"),
      startDetached: notImplemented("orchestrator.startDetached"),
      sandboxDoctor: notImplemented("orchestrator.sandboxDoctor"),
      sandboxStop: notImplemented("orchestrator.sandboxStop"),
      sandboxCleanupOpenworkContainers: notImplemented("orchestrator.sandboxCleanupOpenworkContainers"),
      sandboxDebugProbe: notImplemented("orchestrator.sandboxDebugProbe"),
      onSandboxCreateProgress: notImplementedSubscription<SandboxCreateProgressEvent>(
        "orchestrator.onSandboxCreateProgress",
      ),
    },
    openworkServer: {
      info: notImplemented("openworkServer.info"),
      restart: notImplemented("openworkServer.restart"),
    },
    router: {
      info: notImplemented("router.info"),
      status: notImplemented("router.status"),
      start: notImplemented("router.start"),
      stop: notImplemented("router.stop"),
      restart: notImplemented("router.restart"),
      getGroupsEnabled: notImplemented("router.getGroupsEnabled"),
      setGroupsEnabled: notImplemented("router.setGroupsEnabled"),
    },
    cache: {
      resetOpenworkState: notImplemented("cache.resetOpenworkState"),
      resetOpencodeCache: notImplemented("cache.resetOpencodeCache"),
    },
    obsidian: {
      isAvailable: notImplemented("obsidian.isAvailable"),
      open: notImplemented("obsidian.open"),
      writeMirrorFile: notImplemented("obsidian.writeMirrorFile"),
      readMirrorFile: notImplemented("obsidian.readMirrorFile"),
    },
    scheduler: {
      listJobs: notImplemented("scheduler.listJobs"),
      deleteJob: notImplemented("scheduler.deleteJob"),
    },
    opencode: {
      dbMigrate: notImplemented("opencode.dbMigrate"),
      mcpAuth: notImplemented("opencode.mcpAuth"),
    },
  };
}

contextBridge.exposeInMainWorld("openworkDesktop", createOpenworkDesktopBridge());
