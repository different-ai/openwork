/** Typed access to the Open Coworker main-process bridge. */
import type { AutomationSchedule } from "@openwork/types/automations";
import type { CoworkerDocument, CoworkerDocumentSummary, DocumentRevision, DocumentStatus } from "./documents";
import type { Personality } from "./personalities";
import type { WorkerEvent, WorkerLifespan, WorkerSummary } from "./workers";

/** A group chat: several coworkers in one conversation with the person. */
export type CoworkerGroupSummary = {
  schemaVersion: 1;
  id: string;
  name: string;
  participantSlugs: string[];
  /** The native discussion thread each participant uses for this group, in its own workspace. */
  participantThreadIds: Record<string, string>;
  /** "providerId/modelId" for the silent facilitator; empty means Automatic. */
  facilitatorModel: string;
  /** The facilitator's own native thread for this group, in the hidden coordinator workspace. */
  facilitatorThreadId: string;
  /** The last turns, oldest first: what the view and recovery read instead of component state. */
  turns: CoworkerGroupTurn[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

export type GroupSpeakerStatus = "queued" | "running" | "succeeded" | "passed" | "failed" | "stopped";
/** A speaker replies to the person, follows up on another coworker, or wraps the round up. */
export type GroupSpeakerPart = "reply" | "follow-up" | "wrap-up";

export type GroupSpeakerRun = {
  slug: string;
  order: number;
  status: GroupSpeakerStatus;
  part: GroupSpeakerPart;
  /** One sentence from the facilitator on what this coworker should cover; empty when none. */
  brief: string;
  threadId: string;
  error: string;
  startedAt: number | null;
  endedAt: number | null;
};

export type GroupTurnStatus = "routing" | "running" | "succeeded" | "partial" | "failed" | "stopped";

export type CoworkerGroupTurn = {
  id: string;
  clientMessageId: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  status: GroupTurnStatus;
  mode: "sequential" | "parallel";
  routedBy: "facilitator" | "mentions" | "fallback";
  speakers: GroupSpeakerRun[];
};

export type GroupTimelineEventKind = "user" | "coworker" | "status" | "action";

export type GroupTimelineEvent = {
  id: string;
  at: number;
  kind: GroupTimelineEventKind;
  text: string;
  /** The coworker who spoke (coworker events) or whom a status or action concerns. */
  slug?: string;
  turnId?: string;
  clientMessageId?: string;
  status?: string;
  threadId?: string;
  /** What an action line links to, e.g. `assignment`. */
  action?: string;
  title?: string;
};

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

/** One durable memory: an index line joined with its file in `memory/long-term/`. */
export type LongTermMemory = {
  id: string;
  /** Bare file name, e.g. `cleaning-day.md`. */
  file: string;
  /** Coworker-relative path, e.g. `memory/long-term/cleaning-day.md`. */
  path: string;
  /** First heading of the file, or a readable form of the file name. */
  title: string;
  /** The one-line summary from the index; empty when the file is not indexed. */
  summary: string;
  indexed: boolean;
  exists: boolean;
  /** Last modification time in ms since epoch; 0 when the file is missing. */
  updatedAt: number;
};

export type LocalResponsibilityRun = {
  id: string;
  /** `queued` runs wait for a free slot on this Mac and start by themselves. */
  status: "queued" | "running" | "succeeded" | "failed";
  /** `resume` continues an earlier run inside its own native thread. */
  trigger: "scheduled" | "recovery" | "manual" | "resume";
  queuedAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  threadId: string;
  error: string;
  /** The coworker's own closing words for the run, bounded. */
  summary: string;
};

export type LocalResponsibility = {
  id: string;
  name: string;
  instructions: string;
  schedule: AutomationSchedule;
  state: "active" | "paused";
  nextDueAt: number | null;
  /** Always `runs[0]` when any run exists. */
  latestRun: LocalResponsibilityRun | null;
  /** Newest first, bounded history. */
  runs: LocalResponsibilityRun[];
  createdAt: number;
  updatedAt: number;
};

/** Live picture of responsibility runs on this Mac. */
export type LocalRunStatus = { limit: number; active: number; queued: number };

export type CoworkerSettings = {
  /** How many responsibilities may run at the same time on this Mac (1–4). */
  maxParallelLocalRuns: number;
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

/** What one turn update may change: the whole speaker list, one speaker's progress, routing, or status. */
export type GroupTurnPatch = {
  speakers?: Array<Pick<GroupSpeakerRun, "slug"> & Partial<Omit<GroupSpeakerRun, "slug" | "order">>>;
  speaker?: Pick<GroupSpeakerRun, "slug"> & Partial<Omit<GroupSpeakerRun, "slug" | "order">>;
  mode?: CoworkerGroupTurn["mode"];
  routedBy?: CoworkerGroupTurn["routedBy"];
  status?: GroupTurnStatus;
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
  groups: {
    list: () => invoke<CoworkerGroupSummary[]>("groups.list"),
    get: (id: string) => invoke<CoworkerGroupSummary>("groups.get", { id }),
    create: (input: { name: string; participantSlugs: string[] }) => invoke<CoworkerGroupSummary>("groups.create", input),
    update: (id: string, patch: Partial<Pick<CoworkerGroupSummary, "name" | "participantSlugs" | "participantThreadIds" | "facilitatorModel" | "facilitatorThreadId">>) =>
      invoke<CoworkerGroupSummary>("groups.update", { id, patch }),
    archive: (id: string) => invoke<CoworkerGroupSummary>("groups.archive", { id }),
    readTimeline: (id: string, limit?: number) => invoke<GroupTimelineEvent[]>("groups.readTimeline", { id, limit }),
    appendEvent: (id: string, event: Omit<GroupTimelineEvent, "id" | "at"> & Partial<Pick<GroupTimelineEvent, "id" | "at">>) =>
      invoke<GroupTimelineEvent>("groups.appendEvent", { id, event }),
    /** Opens the turn and writes the person's line; the same client message id returns the existing turn. */
    beginTurn: (id: string, input: { clientMessageId: string; prompt: string }) =>
      invoke<{ group: CoworkerGroupSummary; turn: CoworkerGroupTurn; created: boolean; userEvent: GroupTimelineEvent | null }>("groups.beginTurn", { id, ...input }),
    updateTurn: (id: string, turnId: string, patch: GroupTurnPatch) => invoke<CoworkerGroupTurn>("groups.updateTurn", { id, turnId, patch }),
    /** Settle every turn a quit or reload cut off; returns which ones it touched. */
    recoverInterrupted: () => invoke<{ groupId: string; turnId: string }[]>("groups.recoverInterrupted"),
  },
  /** The hidden workspace the silent facilitator runs in; created and registered on first use. */
  coordinator: {
    ensure: () => invoke<{ path: string; name: string; workspaceId: string }>("coordinator.ensure"),
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
  memory: {
    list: (slug: string) => invoke<LongTermMemory[]>("coworkers.memory.list", { slug }),
    create: (slug: string, input: { title: string; summary?: string }) =>
      invoke<LongTermMemory>("coworkers.memory.create", { slug, ...input }),
    /** Add an index line for a file the coworker wrote without listing it. */
    index: (slug: string, file: string, summary?: string) =>
      invoke<{ ok: boolean }>("coworkers.memory.index", { slug, file, summary }),
    /** Forget a memory: the file and its index line go together. */
    remove: (slug: string, file: string) => invoke<{ ok: boolean }>("coworkers.memory.delete", { slug, file }),
  },
  /**
   * Documents: the coworker writes them through its own tools; the person
   * reads, edits, organizes, exports, and restores them here. A save is a new
   * revision by the person, which the coworker sees in its index next turn.
   */
  documents: {
    list: (slug: string) => invoke<CoworkerDocumentSummary[]>("documents.list", { slug }),
    read: (slug: string, id: string) => invoke<CoworkerDocument>("documents.read", { slug, id }),
    save: (slug: string, id: string, patch: Partial<Pick<CoworkerDocument, "title" | "summary" | "highlights" | "body">>) =>
      invoke<CoworkerDocument & { changed: boolean }>("documents.save", { slug, id, ...patch }),
    setStatus: (slug: string, id: string, status: DocumentStatus) => invoke<CoworkerDocument>("documents.setStatus", { slug, id, status }),
    revisions: (slug: string, id: string) => invoke<DocumentRevision[]>("documents.revisions", { slug, id }),
    restore: (slug: string, id: string, revision: number) => invoke<CoworkerDocument & { changed: boolean }>("documents.restore", { slug, id, revision }),
    /** Opens the native save dialog; `cancelled` when the person closed it. */
    export: (slug: string, id: string) => invoke<{ ok: boolean; cancelled: boolean; path: string }>("documents.export", { slug, id }),
    /** A reply ran long with no document behind it; the coworker's next turn carries a one-line reminder. */
    recordLongReply: (slug: string, messageId: string, chars: number) =>
      invoke<{ recorded: boolean }>("documents.recordLongReply", { slug, messageId, chars }),
  },
  localResponsibilities: {
    list: (slug: string) => invoke<LocalResponsibility[]>("localResponsibilities.list", { slug }),
    create: (slug: string, input: { name: string; instructions: string; schedule: AutomationSchedule }) =>
      invoke<LocalResponsibility>("localResponsibilities.create", { slug, ...input }),
    setActive: (slug: string, id: string, active: boolean) =>
      invoke<LocalResponsibility>("localResponsibilities.setActive", { slug, id, active }),
    remove: (slug: string, id: string) => invoke<{ ok: boolean }>("localResponsibilities.delete", { slug, id }),
    /** Starts now when a slot is free; otherwise the run is recorded as queued. */
    runNow: (slug: string, id: string) =>
      invoke<{ accepted: boolean; queued: boolean; reason: string }>("localResponsibilities.runNow", { slug, id }),
    /** Continue the latest failed run inside its own native thread. */
    resume: (slug: string, id: string) =>
      invoke<{ accepted: boolean; reason: string }>("localResponsibilities.resume", { slug, id }),
    cancelQueued: (slug: string, id: string) =>
      invoke<{ ok: boolean }>("localResponsibilities.cancelQueued", { slug, id }),
    status: () => invoke<LocalRunStatus>("localResponsibilities.status"),
  },
  /**
   * Workers: long-lived sub-agents in the coworker's own workspace. Their turns
   * share this Mac's parallel-run limit with responsibilities, and every
   * finding wakes the coworker in its open discussion.
   */
  workers: {
    list: (slug: string) => invoke<WorkerSummary[]>("workers.list", { slug }),
    get: (slug: string, id: string) => invoke<WorkerSummary>("workers.get", { slug, id }),
    /** A missing lifespan means the default turn budget; a Worker is never unbounded by accident. */
    spawn: (slug: string, input: { name: string; goal: string; lifespan?: WorkerLifespan; spawnedFromThreadId?: string }) =>
      invoke<WorkerSummary>("workers.spawn", { slug, ...input }),
    /** Arrives as the Worker's next turn; if one is in flight, it waits for it. */
    steer: (slug: string, id: string, text: string) => invoke<WorkerSummary>("workers.steer", { slug, id, text }),
    cancel: (slug: string, id: string, reason?: string) => invoke<WorkerSummary>("workers.cancel", { slug, id, reason }),
    pause: (slug: string, id: string) => invoke<WorkerSummary>("workers.pause", { slug, id }),
    resume: (slug: string, id: string) => invoke<WorkerSummary>("workers.resume", { slug, id }),
    findings: (slug: string, id: string, limit?: number) => invoke<WorkerEvent[]>("workers.findings", { slug, id, limit }),
  },
  settings: {
    get: () => invoke<CoworkerSettings>("settings.get"),
    update: (patch: Partial<CoworkerSettings>) => invoke<CoworkerSettings>("settings.update", patch),
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
