/** Typed access to the Open Coworker main-process bridge. */
import type { AutomationSchedule } from "@openwork/types/automations";
import type { Personality } from "./personalities";

export type CoworkerSummary = {
  slug: string;
  path: string;
  name: string;
  role: string;
  mission: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
  /** Voice for the working state only; never changes how the coworker works. */
  personality: Personality;
  workspaceId: string;
  /** Native OpenWork session reserved for ongoing chat, separate from assignments. */
  conversationThreadId: string;
  /** Preferred model as "providerId/modelId"; empty means engine default. */
  model: string;
  /** Optional reasoning/behavior variant for the preferred model. */
  modelVariant: string;
  automations: string[];
  createdAt: string;
};

export type AvatarColor = "blue" | "violet" | "mint" | "orange" | "rose" | "slate";
export type AvatarGlasses = "round" | "square" | "none";

export type RetiredCoworker = {
  archiveId: string;
  slug: string;
  name: string;
  role: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
  retiredAt: string;
  fileCount: number;
  /** False while a live coworker already occupies this slug. */
  canRestore: boolean;
};

export type CoworkerMemoryFile = {
  id: string;
  label: string;
  path: string;
  /** Last modification time in ms since epoch; 0 when unknown. */
  updatedAt: number;
};

export type LocalResponsibilityRun = {
  id: string;
  status: "running" | "succeeded" | "failed";
  trigger: "scheduled" | "recovery" | "manual";
  startedAt: number;
  finishedAt: number | null;
  threadId: string;
  error: string;
};

export type LocalResponsibility = {
  id: string;
  name: string;
  instructions: string;
  schedule: AutomationSchedule;
  state: "active" | "paused";
  nextDueAt: number | null;
  latestRun: LocalResponsibilityRun | null;
  createdAt: number;
  updatedAt: number;
};

export type RuntimeInfo = {
  appName: string;
  version: string;
  serverUrl: string;
  ownerToken: string;
  coworkersDir: string;
  denBaseUrl: string;
  /** URL scheme Den uses to hand a sign-in grant back to this app. */
  deepLinkScheme: string;
  /** False in unpackaged or isolated launches, where only the pasted link works. */
  deepLinksRegistered: boolean;
  engineManaged: boolean;
  engineError: string;
};

/** Outcome of one embedded-server provider sync pass for the signed-in account. */
export type ProviderSyncRun = {
  status: "applied" | "noop" | "failed" | "no_session";
  message: string;
};

type BridgeResponse = { ok: true; result: unknown } | { ok: false; error: string };

type BridgeWindow = Window & {
  __COWORKER__?: {
    invoke: (command: string, payload?: unknown) => Promise<BridgeResponse>;
    onDeepLink?: (listener: (urls: string[]) => void) => () => void;
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
  /** Stop and start the local AI service, then report the fresh state. */
  restartRuntime: () => invoke<RuntimeInfo>("runtime.restart"),
  coworkers: {
    list: () => invoke<CoworkerSummary[]>("coworkers.list"),
    get: (slug: string) => invoke<CoworkerSummary>("coworkers.get", { slug }),
    create: (input: { name: string; role: string; mission: string; avatarColor: AvatarColor; avatarGlasses: AvatarGlasses; personality: Personality }) =>
      invoke<CoworkerSummary>("coworkers.create", input),
    update: (slug: string, patch: Partial<Pick<CoworkerSummary, "workspaceId" | "conversationThreadId" | "automations" | "mission" | "role" | "model" | "modelVariant" | "avatarColor" | "avatarGlasses" | "personality">>) =>
      invoke<CoworkerSummary>("coworkers.update", { slug, patch }),
    ensureWorkspace: (slug: string) => invoke<CoworkerSummary>("coworkers.ensureWorkspace", { slug }),
    /** Retire: archive the whole home under `.retired/`; nothing is deleted. */
    remove: (slug: string) => invoke<{ ok: boolean; archiveId: string }>("coworkers.delete", { slug }),
    listRetired: () => invoke<RetiredCoworker[]>("coworkers.retired.list"),
    restore: (archiveId: string) => invoke<CoworkerSummary>("coworkers.restore", { archiveId }),
    deleteRetired: (archiveId: string) => invoke<{ ok: boolean }>("coworkers.retired.delete", { archiveId }),
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
  localResponsibilities: {
    list: (slug: string) => invoke<LocalResponsibility[]>("localResponsibilities.list", { slug }),
    create: (slug: string, input: { name: string; instructions: string; schedule: AutomationSchedule }) =>
      invoke<LocalResponsibility>("localResponsibilities.create", { slug, ...input }),
    setActive: (slug: string, id: string, active: boolean) =>
      invoke<LocalResponsibility>("localResponsibilities.setActive", { slug, id, active }),
    remove: (slug: string, id: string) => invoke<{ ok: boolean }>("localResponsibilities.delete", { slug, id }),
    runNow: (slug: string, id: string) =>
      invoke<{ accepted: boolean }>("localResponsibilities.runNow", { slug, id }),
  },
  openExternal: (url: string) => invoke<{ ok: boolean }>("shell.openExternal", { url }),
  openUntrustedExternal: (url: string) =>
    invoke<{ ok: boolean; cancelled?: boolean }>("shell.openUntrustedExternal", { url }),
  /**
   * The signed-in OpenWork account, handed to the embedded server so the
   * member's authorized providers become engine providers — the desktop's
   * own sync path, not a Coworker-specific one.
   */
  den: {
    setSession: (session: { baseUrl: string; token: string; orgId: string }) =>
      invoke<ProviderSyncRun>("den.session.set", session),
    clearSession: () => invoke<{ ok: boolean }>("den.session.clear"),
    syncProviders: () => invoke<ProviderSyncRun>("den.providers.sync"),
  },
  /**
   * Subscribe to OS-delivered `opencoworker://` links. Links that arrived
   * before the renderer was listening are replayed through the same callback.
   */
  onDeepLink: (listener: (urls: string[]) => void): (() => void) => {
    const bridge = (window as BridgeWindow).__COWORKER__;
    if (!bridge?.onDeepLink) return () => undefined;
    const unsubscribe = bridge.onDeepLink(listener);
    void invoke<{ urls: string[] }>("deepLinks.subscribe")
      .then((pending) => {
        if (pending.urls.length > 0) listener(pending.urls);
      })
      .catch(() => undefined);
    return unsubscribe;
  },
};
