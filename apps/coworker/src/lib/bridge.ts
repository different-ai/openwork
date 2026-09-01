/** Typed access to the Open Coworker main-process bridge. */

export type CoworkerSummary = {
  slug: string;
  path: string;
  name: string;
  role: string;
  mission: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
  workspaceId: string;
  /** Preferred model as "providerId/modelId"; empty means engine default. */
  model: string;
  automations: string[];
  createdAt: string;
};

export type AvatarColor = "blue" | "violet" | "mint" | "orange" | "rose" | "slate";
export type AvatarGlasses = "round" | "square" | "none";

export type CoworkerMemoryFile = {
  id: string;
  label: string;
  path: string;
};

export type RuntimeInfo = {
  appName: string;
  version: string;
  serverUrl: string;
  ownerToken: string;
  coworkersDir: string;
  denBaseUrl: string;
  engineManaged: boolean;
  engineError: string;
  allowOffline: boolean;
};

type BridgeResponse = { ok: true; result: unknown } | { ok: false; error: string };

type BridgeWindow = Window & {
  __COWORKER__?: {
    invoke: (command: string, payload?: unknown) => Promise<BridgeResponse>;
  };
};

async function invoke<T>(command: string, payload?: unknown): Promise<T> {
  const bridge = (window as BridgeWindow).__COWORKER__;
  if (!bridge) {
    throw new Error("Open Coworker bridge is unavailable. Launch through the Open Coworker app.");
  }
  const response = await bridge.invoke(command, payload);
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

export const coworkerBridge = {
  runtimeInfo: () => invoke<RuntimeInfo>("runtime.info"),
  coworkers: {
    list: () => invoke<CoworkerSummary[]>("coworkers.list"),
    get: (slug: string) => invoke<CoworkerSummary>("coworkers.get", { slug }),
    create: (input: { name: string; role: string; mission: string; avatarColor: AvatarColor; avatarGlasses: AvatarGlasses }) =>
      invoke<CoworkerSummary>("coworkers.create", input),
    update: (slug: string, patch: Partial<Pick<CoworkerSummary, "workspaceId" | "automations" | "mission" | "role" | "model" | "avatarColor" | "avatarGlasses">>) =>
      invoke<CoworkerSummary>("coworkers.update", { slug, patch }),
    ensureWorkspace: (slug: string) => invoke<CoworkerSummary>("coworkers.ensureWorkspace", { slug }),
    remove: (slug: string) => invoke<{ ok: boolean }>("coworkers.delete", { slug }),
  },
  files: {
    list: (slug: string) => invoke<CoworkerMemoryFile[]>("coworkers.files.list", { slug }),
    read: async (slug: string, path: string) => {
      const payload = await invoke<{ content: string }>("coworkers.files.read", { slug, path });
      return payload.content;
    },
    write: (slug: string, path: string, content: string) =>
      invoke<{ ok: boolean }>("coworkers.files.write", { slug, path, content }),
  },
  openExternal: (url: string) => invoke<{ ok: boolean }>("shell.openExternal", { url }),
};
