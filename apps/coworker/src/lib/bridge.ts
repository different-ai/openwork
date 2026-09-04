/** Typed access to the Open Coworker main-process bridge. */
import type { CoworkerDocument, CoworkerDocumentSummary, DocumentRevision, DocumentStatus } from "./documents";
import type { LocalSchedule } from "./local-schedule.ts";
import type { EffortStop } from "./effort.ts";
import type { ModelMode } from "./model-choice.ts";
import type { Personality } from "./personalities";
import type { WorkerEvent, WorkerLifespan, WorkerSummary } from "./workers";
import type { AssignedCoworkerTemplate } from "@openwork/types/coworker-template";

export type CoworkerTemplateSync = {
  /** Present only for organization discovery, not local file imports. */
  enabled?: boolean;
  items: Array<AssignedCoworkerTemplate & { installed: boolean; slug: string | null; updateAvailable: boolean }>;
  created: CoworkerSummary[];
};

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
  /** The catalog role this coworker was created from; "" when the person shaped it by hand. */
  roleId: string;
  /** The teammate who proposed this coworker and why; null when the person added it themselves. */
  suggestedBy: { slug: string; why: string } | null;
  workspaceId: string;
  /** Native OpenWork session reserved for ongoing chat, separate from assignments. */
  conversationThreadId: string;
  /** Preferred model as "providerId/modelId"; empty means engine default. In `auto` mode this is the standard model the lanes anchor on. */
  model: string;
  /** Optional reasoning/behavior variant for the preferred model. */
  modelVariant: string;
  /** Who chose the model: the app by itself ("app", may be swapped once when it fails), the person ("person"), or "" for a record that never said (read as the person's). */
  modelChosenBy: ModelChosenBy;
  /** `auto`: a quick, standard, or deep model per message around `model`; `fixed`: `model` every time. */
  modelMode: ModelMode;
  /** The effort dial (Light … All in): a preference each turn's effort is derived from, never used as is. */
  effortPreference: EffortStop;
  automations: string[];
  createdAt: string;
};

export type ModelChosenBy = "app" | "person" | "";

export type AvatarColor = "blue" | "violet" | "mint" | "orange" | "rose" | "slate" | "sand";
export type AvatarGlasses = "round" | "square" | "oval" | "none";

/** One role from the team catalog, as onboarding and the Add screen propose it. */
export type TeamRole = {
  id: string;
  defaultName: string;
  role: string;
  /** What this kind of coworker helps with, for the person choosing: "Schedules, reminders, and follow-ups". */
  pitch: string;
  mission: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
  personality: Personality;
};

/** A proposed coworker before it exists: a catalog role with a name the person may change. */
export type TeamDraft = Omit<TeamRole, "id" | "defaultName" | "pitch"> & { roleId: string; name: string };

export type TeamSuggestionState = "offered" | "accepted" | "declined";
export type TeamReferralState = "offered" | "asked" | "continued";

/** What the conversation restores after a reload: how the person answered each offer. */
export type TeamStates = {
  suggestions: Array<{ id: string; state: TeamSuggestionState; at: number; createdSlug: string }>;
  referrals: Array<{ id: string; state: TeamReferralState; at: number }>;
};

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
  /** The shared once/daily/weekly contract, or a local-only interval or custom timetable. */
  schedule: LocalSchedule;
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
  /** How many responsibilities may run at the same time on this Mac (1–8). */
  maxParallelLocalRuns: number;
  /** The least time between two runs of one assignment on this Mac: 15, 30, or 60 minutes. */
  minimumRunGapMinutes: number;
  /** The most runs one assignment may make in a day on this Mac. */
  maxRunsPerDay: number;
};

/** One recorded change to the coworker's memory or soul, by the coworker, the person, or an undo. */
export type MemoryChange = {
  id: string;
  at: number;
  actor: "coworker" | "person" | "undo";
  /** The tool that made it (`memory_remember`, `soul_update`, …), `edit` for a person's edit, `undo` for an undo. */
  tool: string;
  input: Record<string, unknown>;
  /** The first line of what the tool answered. */
  output: string;
  /** What changed in each file, as short excerpts; null when the file did not exist. */
  files: Array<{ path: string; before: string | null; after: string | null }>;
  /** The change this one undid, when it is an undo. */
  undoes: string | null;
  /** True once a later change undid this one. */
  undone: boolean;
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

/**
 * Something already on this Mac a coworker could use. `how` says what Connect
 * does: `import` hands an existing sign-in to the AI service as it is, `add`
 * points the AI service at a local server, `in-use` is already available, and
 * `unavailable` carries the plain reason. Never a path to a secret file, never
 * a value.
 */
export type LocalProviderFinding = {
  id: string;
  kind: "codex" | "claude-code" | "copilot" | "opencode" | "env" | "server";
  label: string;
  detail: string;
  providerId: string;
  how: "import" | "add" | "in-use" | "unavailable";
  reason: string;
  envName?: string;
  address?: string;
  models?: string[];
};

export type LocalProviderDetection = { found: LocalProviderFinding[]; checkedAt: number };

/** One AI provider as the AI service knows it, whether or not anything connects it yet. */
export type EngineProviderSummary = {
  id: string;
  name: string;
  /** Environment variable names that would connect it; the first is the key's usual name. */
  env: string[];
  source: string;
  connected: boolean;
  modelCount: number;
};

export type LocalProvidersReadiness = {
  workspaceId: string;
  engineManaged: boolean;
  /** The platform's live address and owner token; preparing the first workspace can move the port. */
  serverUrl: string;
  ownerToken: string;
  providers: EngineProviderSummary[];
  /** Provider id → the AI service's own sign-in flows (browser or device code). */
  signIns: Record<string, Array<{ index: number; label: string }>>;
};

export type LocalProviderConnected = { status: "connected"; providerId: string; label: string; modelCount: number };
export type LocalProviderConnectResult =
  | LocalProviderConnected
  | { status: "failed"; providerId: string; label: string; error: string; fallback: "sign-in" };

export type ProviderSignInStart = {
  attemptId: string;
  providerId: string;
  url: string;
  /** A device code to enter in the browser, when the flow uses one. */
  code: string;
  instructions: string;
  label: string;
};

export type ProviderSignInStatus = { state: "waiting" | "connected" | "failed"; error: string; modelCount: number };

export type ProviderDisconnectResult = { removed: boolean; needsConfirmation: boolean; note: string };

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
  templates: {
    sync: (input: { userEmail: string; automatic?: boolean; installIds?: string[] }) => invoke<CoworkerTemplateSync>("templates.sync", input),
    import: () => invoke<CoworkerTemplateSync | null>("templates.import"),
    export: (slug: string) => invoke<{ saved: boolean }>("templates.export", { slug }),
  },
  runtimeInfo: () => invoke<RuntimeInfo>("runtime.info"),
  /** Stop and start the local AI service, then report the fresh state. */
  restartRuntime: () => invoke<RuntimeInfo>("runtime.restart"),
  coworkers: {
    list: () => invoke<CoworkerSummary[]>("coworkers.list"),
    get: (slug: string) => invoke<CoworkerSummary>("coworkers.get", { slug }),
    create: (input: { name: string; role: string; mission: string; avatarColor: AvatarColor; avatarGlasses: AvatarGlasses; personality: Personality; roleId?: string; firstNote?: string }) =>
      invoke<CoworkerSummary>("coworkers.create", input),
    update: (slug: string, patch: Partial<Pick<CoworkerSummary, "workspaceId" | "conversationThreadId" | "automations" | "mission" | "role" | "model" | "modelVariant" | "modelChosenBy" | "modelMode" | "effortPreference" | "avatarColor" | "avatarGlasses" | "personality">>) =>
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
  /**
   * The team: the catalog onboarding proposes from, and the person's answers to
   * a coworker's offers. Only `accept` ever creates a coworker.
   */
  team: {
    catalog: () => invoke<TeamRole[]>("team.catalog"),
    recommend: (intents: string[]) => invoke<TeamDraft[]>("team.recommend", { intents }),
    states: (slug: string) => invoke<TeamStates>("team.states", { slug }),
    /** Add the proposed coworker; it inherits the proposer's model and remembers who proposed it. */
    accept: (slug: string, suggestionId: string, name?: string) => invoke<CoworkerSummary>("team.accept", { slug, suggestionId, name }),
    decline: (slug: string, suggestionId: string) => invoke<{ id: string; state: TeamSuggestionState; at: number }>("team.decline", { slug, suggestionId }),
    referralResolved: (slug: string, referralId: string, outcome: "asked" | "continued") =>
      invoke<{ id: string; state: TeamReferralState; at: number }>("team.referralResolved", { slug, referralId, outcome }),
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
    /** Recent changes to memory and soul, newest first. */
    changes: (slug: string, limit?: number) => invoke<MemoryChange[]>("coworkers.memory.changes", { slug, limit }),
    /** Put the files a change touched back as they were; the undo is recorded as a change too. */
    undo: (slug: string, changeId: string) => invoke<MemoryChange>("coworkers.memory.undo", { slug, changeId }),
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
    create: (slug: string, input: { name: string; instructions: string; schedule: LocalSchedule }) =>
      invoke<LocalResponsibility>("localResponsibilities.create", { slug, ...input }),
    /** Change a responsibility in place: name, instructions, schedule, or whether it is active. */
    update: (slug: string, id: string, patch: Partial<{ name: string; instructions: string; schedule: LocalSchedule; active: boolean }>) =>
      invoke<LocalResponsibility>("localResponsibilities.update", { slug, id, patch }),
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
   * AI providers on this Mac. Everything goes through the AI service's own
   * credential store and sign-in flows in the main process; a key typed here
   * travels once and is never read back.
   */
  localProviders: {
    /** Make sure the AI service is reachable (before any coworker exists too) and read what it offers. */
    prepare: () => invoke<LocalProvidersReadiness>("localProviders.prepare"),
    detect: () => invoke<LocalProviderDetection>("localProviders.detect"),
    connect: (id: string) => invoke<LocalProviderConnectResult>("localProviders.connect", { id }),
    saveKey: (providerId: string, key: string) => invoke<LocalProviderConnected>("localProviders.saveKey", { providerId, key }),
    disconnect: (providerId: string, confirmed: boolean) =>
      invoke<ProviderDisconnectResult>("localProviders.disconnect", { providerId, confirmed }),
    signIn: {
      start: (providerId: string, method?: number) => invoke<ProviderSignInStart>("localProviders.signIn.start", { providerId, method }),
      status: (attemptId: string) => invoke<ProviderSignInStatus>("localProviders.signIn.status", { attemptId }),
      cancel: (attemptId: string) => invoke<{ ok: boolean }>("localProviders.signIn.cancel", { attemptId }),
    },
    custom: {
      /** Lists the models a server answers with before anything is saved. */
      probe: (address: string, key: string) => invoke<{ address: string; models: string[] }>("localProviders.custom.probe", { address, key }),
      add: (input: { name: string; address: string; key: string; models: string[] }) =>
        invoke<LocalProviderConnected>("localProviders.custom.add", input),
    },
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
