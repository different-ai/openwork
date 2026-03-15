const IPC_NAMESPACE = "openwork" as const;
const IPC_EVENT_NAMESPACE = `${IPC_NAMESPACE}:event` as const;

export const IPC_NAMESPACES = [
  "runtime",
  "app",
  "window",
  "dialogs",
  "shell",
  "paths",
  "deepLinks",
  "updates",
  "workspace",
  "commandFiles",
  "config",
  "skills",
  "packages",
  "engine",
  "orchestrator",
  "openworkServer",
  "router",
  "cache",
  "obsidian",
  "scheduler",
  "opencode",
] as const;

export const IPC_EVENT_NAMES = [
  "deepLinkOpen",
  "updateStatus",
  "sandboxCreateProgress",
  "reloadRequired",
] as const;

export type IpcNamespace = (typeof IPC_NAMESPACES)[number];
export type IpcEventName = (typeof IPC_EVENT_NAMES)[number];
export type IpcMethodChannel<
  N extends IpcNamespace = IpcNamespace,
  M extends string = string,
> = `${typeof IPC_NAMESPACE}:${N}:${M}`;
export type IpcEventChannel<E extends string = string> = `${typeof IPC_EVENT_NAMESPACE}:${E}`;

function validateIpcSegment(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
    throw new Error(`${label} must be alphanumeric camelCase`);
  }
  return trimmed;
}

export function createIpcChannel<N extends IpcNamespace, M extends string>(
  namespace: N,
  method: M,
): IpcMethodChannel<N, M> {
  const safeMethod = validateIpcSegment(method, "method");
  return `${IPC_NAMESPACE}:${namespace}:${safeMethod}` as IpcMethodChannel<N, M>;
}

export function createIpcEventChannel<E extends string>(name: E): IpcEventChannel<E> {
  const safeName = validateIpcSegment(name, "event name");
  return `${IPC_EVENT_NAMESPACE}:${safeName}` as IpcEventChannel<E>;
}

function createNamespaceChannelFactory<N extends IpcNamespace>(namespace: N) {
  return <M extends string>(method: M) => createIpcChannel(namespace, method);
}

export const IPC_CHANNELS = {
  runtime: createNamespaceChannelFactory("runtime"),
  app: createNamespaceChannelFactory("app"),
  window: createNamespaceChannelFactory("window"),
  dialogs: createNamespaceChannelFactory("dialogs"),
  shell: createNamespaceChannelFactory("shell"),
  paths: createNamespaceChannelFactory("paths"),
  deepLinks: createNamespaceChannelFactory("deepLinks"),
  updates: createNamespaceChannelFactory("updates"),
  workspace: createNamespaceChannelFactory("workspace"),
  commandFiles: createNamespaceChannelFactory("commandFiles"),
  config: createNamespaceChannelFactory("config"),
  skills: createNamespaceChannelFactory("skills"),
  packages: createNamespaceChannelFactory("packages"),
  engine: createNamespaceChannelFactory("engine"),
  orchestrator: createNamespaceChannelFactory("orchestrator"),
  openworkServer: createNamespaceChannelFactory("openworkServer"),
  router: createNamespaceChannelFactory("router"),
  cache: createNamespaceChannelFactory("cache"),
  obsidian: createNamespaceChannelFactory("obsidian"),
  scheduler: createNamespaceChannelFactory("scheduler"),
  opencode: createNamespaceChannelFactory("opencode"),
} as const;

export const IPC_EVENT_CHANNELS = {
  deepLinkOpen: createIpcEventChannel("deepLinkOpen"),
  updateStatus: createIpcEventChannel("updateStatus"),
  sandboxCreateProgress: createIpcEventChannel("sandboxCreateProgress"),
  reloadRequired: createIpcEventChannel("reloadRequired"),
} as const;

export const IPC_CHANNEL_PREFIX = `${IPC_NAMESPACE}:` as const;
export const IPC_EVENT_CHANNEL_PREFIX = `${IPC_EVENT_NAMESPACE}:` as const;
