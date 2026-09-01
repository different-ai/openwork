/** Typed access to the Work Bot main-process bridge. */

export type BotSummary = {
  slug: string;
  path: string;
  name: string;
  role: string;
  mission: string;
  workspaceId: string;
  /** Preferred model as "providerId/modelId"; empty means engine default. */
  model: string;
  automations: string[];
  createdAt: string;
};

export type BotMemoryFile = {
  id: string;
  label: string;
  path: string;
};

export type RuntimeInfo = {
  appName: string;
  version: string;
  serverUrl: string;
  ownerToken: string;
  botsDir: string;
  denBaseUrl: string;
  engineManaged: boolean;
  engineError: string;
  allowOffline: boolean;
};

type BridgeResponse = { ok: true; result: unknown } | { ok: false; error: string };

type BridgeWindow = Window & {
  __WORKBOT__?: {
    invoke: (command: string, payload?: unknown) => Promise<BridgeResponse>;
  };
};

async function invoke<T>(command: string, payload?: unknown): Promise<T> {
  const bridge = (window as BridgeWindow).__WORKBOT__;
  if (!bridge) {
    throw new Error("Work Bot bridge is unavailable. Launch through the Work Bot app.");
  }
  const response = await bridge.invoke(command, payload);
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

export const workbot = {
  runtimeInfo: () => invoke<RuntimeInfo>("runtime.info"),
  bots: {
    list: () => invoke<BotSummary[]>("bots.list"),
    get: (slug: string) => invoke<BotSummary>("bots.get", { slug }),
    create: (input: { name: string; role: string; mission: string }) =>
      invoke<BotSummary>("bots.create", input),
    update: (slug: string, patch: Partial<Pick<BotSummary, "workspaceId" | "automations" | "mission" | "role" | "model">>) =>
      invoke<BotSummary>("bots.update", { slug, patch }),
    ensureWorkspace: (slug: string) => invoke<BotSummary>("bots.ensureWorkspace", { slug }),
    remove: (slug: string) => invoke<{ ok: boolean }>("bots.delete", { slug }),
  },
  files: {
    list: (slug: string) => invoke<BotMemoryFile[]>("bots.files.list", { slug }),
    read: async (slug: string, path: string) => {
      const payload = await invoke<{ content: string }>("bots.files.read", { slug, path });
      return payload.content;
    },
    write: (slug: string, path: string, content: string) =>
      invoke<{ ok: boolean }>("bots.files.write", { slug, path, content }),
  },
  openExternal: (url: string) => invoke<{ ok: boolean }>("shell.openExternal", { url }),
};
