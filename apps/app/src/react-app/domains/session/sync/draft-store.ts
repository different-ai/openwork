/** @jsxImportSource react */
import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { PromptMode } from "../../../../app/types";
import { z } from "zod";
import { autoAccessWallSchema } from "@/app/lib/inference-access";

export const rejectedTurnSchema = z.object({
  id: z.string().min(1), text: z.string(), created: z.number().finite(), afterMessageId: z.string().nullable(),
  wall: autoAccessWallSchema,
  attachments: z.array(z.object({ name: z.string(), mime: z.string(), url: z.string().startsWith("file://").optional() })),
});
export type RejectedTurn = z.infer<typeof rejectedTurnSchema>;
export const rejectedTurnOwnerSchema = z.object({ scopeId: z.string().nullable(), denBaseUrl: z.string().min(1), runtime: z.string().min(1), workspaceId: z.string().min(1), sessionId: z.string().min(1) });
export type RejectedTurnOwner = z.infer<typeof rejectedTurnOwnerSchema>;
const recoverySchema = z.object({ from: z.string(), id: z.string(), denBaseUrl: z.string(), expiresAt: z.number().finite() });
export function rejectedTurnOwner(input: { draftScope: string | null; denBaseUrl: string; opencodeBaseUrl: string; workspaceId: string; sessionId: string; localRuntime: boolean }): RejectedTurnOwner {
  let runtime = "";
  let denBaseUrl = "";
  try {
    const url = new URL(input.opencodeBaseUrl);
    const den = new URL(input.denBaseUrl);
    runtime = input.localRuntime ? `desktop:${url.pathname}` : `${url.origin}${url.pathname}`;
    denBaseUrl = `${den.origin}${den.pathname}`.replace(/\/+$/, "");
  } catch {}
  return { scopeId: input.draftScope, denBaseUrl, runtime, workspaceId: input.workspaceId, sessionId: input.sessionId };
}
export function rejectedTurnOwnerKey(owner: RejectedTurnOwner) {
  return owner.scopeId && owner.denBaseUrl && owner.runtime && owner.workspaceId && owner.sessionId
    ? JSON.stringify([owner.scopeId, owner.denBaseUrl, owner.runtime, owner.workspaceId, owner.sessionId]) : "";
}
const rejectedOwnerKeySchema = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]);
function rejectedOwnerParts(key: string) {
  try { return rejectedOwnerKeySchema.parse(JSON.parse(key)); } catch { return null; }
}

export type SessionDraftSnapshot = {
  text: string;
  mode: PromptMode;
  /**
   * Text of the follow-ups queued behind a running task ("Send when agent
   * finishes"), in send order. Present only while at least one is waiting.
   * Kept beside the composer text so a restart can hand them back as an
   * unsent draft instead of dropping them or sending them unattended.
   */
  queued?: string[];
};

export type SessionDraftIdentity = {
  principalId: string;
  organizationId: string;
};

export type SessionDraftWriteResult =
  | { status: "saved"; snapshot: SessionDraftSnapshot | null }
  | { status: "conflict"; snapshot: SessionDraftSnapshot | null }
  | { status: "unavailable"; snapshot: SessionDraftSnapshot | null };

type StoredDraft = {
  text: string;
  mode: PromptMode;
  queued: string[];
  revision: number;
};

type DraftDocument = {
  version: 2;
  nextRevision: number;
  drafts: Record<string, StoredDraft>;
  rejected: Record<string, RejectedTurn[]>;
  recovery: z.infer<typeof recoverySchema> | null;
  moved: Record<string, string>;
};

type DraftStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type DraftStorageMutation = {
  key: string | null;
  newValue: string | null;
};

type DraftStoreOptions = {
  storage: DraftStorage;
  subscribeToStorage?: (listener: (mutation: DraftStorageMutation) => void) => () => void;
};

export const SESSION_DRAFT_STORAGE_KEY = "openwork.session-drafts.v2";
export const LEGACY_SESSION_DRAFT_STORAGE_KEY = "openwork.session-drafts.v1";
export const LOCAL_SESSION_DRAFT_SCOPE = "local";
export const MAX_SESSION_DRAFT_COUNT = 100;
/**
 * Reserved session slot for the prompt typed in a workspace's new-task
 * composer before its session exists. Engine session ids are `ses_…`, so this
 * can never collide with a real conversation.
 */
export const NEW_TASK_DRAFT_SESSION_ID = "__new-task__";

const EMPTY_DOCUMENT: DraftDocument = {
  version: 2,
  nextRevision: 1,
  drafts: {},
  rejected: {},
  recovery: null,
  moved: {},
};

const isPromptMode = (value: unknown): value is PromptMode =>
  value === "prompt" || value === "shell";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedOpaqueId = (value: string) => encodeURIComponent(value.trim());

const parseQueued = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

const isEmptyStoredDraft = (draft: Pick<StoredDraft, "text" | "mode" | "queued">) =>
  !draft.text && draft.mode === "prompt" && draft.queued.length === 0;

export function cloudSessionDraftScope(identity: SessionDraftIdentity | null | undefined): string | null {
  const principalId = identity?.principalId.trim() ?? "";
  const organizationId = identity?.organizationId.trim() ?? "";
  if (!principalId || !organizationId) return null;
  return `cloud:${normalizedOpaqueId(principalId)}:${normalizedOpaqueId(organizationId)}`;
}

export function resolveSessionDraftScope(input: {
  hasCloudCredential: boolean;
  verifiedIdentity: SessionDraftIdentity | null | undefined;
}) {
  return input.hasCloudCredential
    ? cloudSessionDraftScope(input.verifiedIdentity)
    : LOCAL_SESSION_DRAFT_SCOPE;
}

export function sessionDraftScopeKey(
  scopeId: string | null | undefined,
  workspaceId: string,
  sessionId: string | null | undefined,
) {
  const scope = scopeId?.trim() ?? "";
  const workspace = workspaceId.trim();
  const session = sessionId?.trim() ?? "";
  if (!scope || !workspace || !session) return "";
  return [scope, workspace, session].map(normalizedOpaqueId).join("|");
}

function parseDocument(raw: string | null): DraftDocument {
  if (!raw) return EMPTY_DOCUMENT;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.drafts)) {
      return EMPTY_DOCUMENT;
    }

    const drafts: Record<string, StoredDraft> = {};
    let highestRevision = 0;
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!key || !isRecord(value) || typeof value.text !== "string" || !isPromptMode(value.mode)) continue;
      if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) continue;
      const queued = parseQueued(value.queued);
      if (isEmptyStoredDraft({ text: value.text, mode: value.mode, queued })) continue;
      drafts[key] = { text: value.text, mode: value.mode, queued, revision: value.revision };
      highestRevision = Math.max(highestRevision, value.revision);
    }

    const declaredNextRevision = typeof parsed.nextRevision === "number"
      && Number.isSafeInteger(parsed.nextRevision)
      && parsed.nextRevision > 0
      ? parsed.nextRevision
      : 1;

    const rejected: Record<string, RejectedTurn[]> = {};
    if (isRecord(parsed.rejected)) for (const [key, rows] of Object.entries(parsed.rejected)) {
      if (!rejectedOwnerParts(key) || !Array.isArray(rows)) continue;
      const turns = rows.flatMap((row) => { const result = rejectedTurnSchema.safeParse(row); return result.success ? [result.data] : []; });
      if (turns.length) rejected[key] = [...new Map(turns.map((turn) => [turn.id, turn])).values()];
    }
    const recovery = recoverySchema.safeParse(parsed.recovery);
    const moved: Record<string, string> = {};
    if (isRecord(parsed.moved)) for (const [key, destination] of Object.entries(parsed.moved)) {
      if (typeof destination === "string" && rejectedOwnerParts(destination)) moved[key] = destination;
    }
    return {
      version: 2,
      nextRevision: Math.max(declaredNextRevision, highestRevision + 1),
      drafts, rejected, recovery: recovery.success ? recovery.data : null, moved,
    };
  } catch {
    return EMPTY_DOCUMENT;
  }
}

function sameStoredDraft(left: StoredDraft | undefined, right: StoredDraft | undefined) {
  if (!left || !right) return left === right;
  return left.revision === right.revision
    && left.text === right.text
    && left.mode === right.mode
    && left.queued.length === right.queued.length
    && left.queued.every((item, index) => item === right.queued[index]);
}

function documentFingerprint(document: DraftDocument) {
  return JSON.stringify(document);
}

/**
 * A context-local draft store. Each browser window owns one instance while
 * sharing localStorage with its peers. Mutations always merge against a fresh
 * read and use the last observed per-draft revision as a compare-and-swap
 * guard, so an old tab cannot replace a newer draft or resurrect a clear.
 */
export function createSessionDraftStore(options: DraftStoreOptions) {
  let cache: DraftDocument | null = null;
  let cacheFingerprint = "";
  let legacyHandled = false;
  const listeners = new Set<() => void>();
  const visibleSnapshots = new WeakMap<StoredDraft, SessionDraftSnapshot>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const readRaw = () => {
    try {
      return options.storage.getItem(SESSION_DRAFT_STORAGE_KEY);
    } catch {
      return null;
    }
  };

  const removeAmbiguousLegacyDrafts = () => {
    if (legacyHandled) return;
    legacyHandled = true;
    try {
      if (options.storage.getItem(LEGACY_SESSION_DRAFT_STORAGE_KEY) !== null) {
        // v1 has no identity or organization boundary. It cannot be safely
        // attributed even to the unsigned local scope, so migration is
        // deliberately fail-closed rather than exposing ambiguous text.
        options.storage.removeItem(LEGACY_SESSION_DRAFT_STORAGE_KEY);
      }
    } catch {
      // Storage may be unavailable in privacy modes; drafts remain in-memory.
    }
  };

  const replaceCache = (document: DraftDocument) => {
    const nextFingerprint = documentFingerprint(document);
    const changed = cache !== null && cacheFingerprint !== nextFingerprint;
    cache = document;
    cacheFingerprint = nextFingerprint;
    if (changed) emit();
  };

  const loadCache = () => {
    removeAmbiguousLegacyDrafts();
    if (!cache) replaceCache(parseDocument(readRaw()));
    return cache ?? EMPTY_DOCUMENT;
  };

  const reconcile = (raw = readRaw()) => {
    removeAmbiguousLegacyDrafts();
    replaceCache(parseDocument(raw));
  };

  const storageCleanup = options.subscribeToStorage?.((mutation) => {
    if (mutation.key !== null && mutation.key !== SESSION_DRAFT_STORAGE_KEY) return;
    reconcile(mutation.key === SESSION_DRAFT_STORAGE_KEY ? mutation.newValue : readRaw());
  });

  const write = (document: DraftDocument) => {
    const serialized = JSON.stringify(document);
    try {
      options.storage.setItem(SESSION_DRAFT_STORAGE_KEY, serialized);
      replaceCache(document);
      return true;
    } catch {
      return false;
    }
  };

  const currentSnapshot = (key: string) => {
    const stored = loadCache().drafts[key];
    if (!stored) return null;
    const existing = visibleSnapshots.get(stored);
    if (existing) return existing;
    const snapshot: SessionDraftSnapshot = stored.queued.length > 0
      ? { text: stored.text, mode: stored.mode, queued: [...stored.queued] }
      : { text: stored.text, mode: stored.mode };
    visibleSnapshots.set(stored, snapshot);
    return snapshot;
  };

  /**
   * Replace one stored entry under the same compare-and-swap guard as `save`.
   * `next` returning null deletes the entry.
   */
  const replaceEntry = (
    key: string,
    next: (latest: StoredDraft | undefined, revision: number) => StoredDraft | null,
  ): SessionDraftWriteResult => {
    const expected = loadCache().drafts[key];
    const latestDocument = parseDocument(readRaw());
    const latest = latestDocument.drafts[key];
    if (!sameStoredDraft(expected, latest)) {
      replaceCache(latestDocument);
      return { status: "conflict", snapshot: currentSnapshot(key) };
    }
    const entry = next(latest, latestDocument.nextRevision);
    if (entry === null && !latest) return { status: "saved", snapshot: null };
    if (entry !== null && latest && sameStoredDraft({ ...entry, revision: latest.revision }, latest)) {
      return { status: "saved", snapshot: currentSnapshot(key) };
    }

    const drafts = { ...latestDocument.drafts };
    if (entry === null) delete drafts[key];
    else drafts[key] = entry;
    const oldest = Object.entries(drafts)
      .sort((left, right) => left[1].revision - right[1].revision)
      .slice(0, Math.max(0, Object.keys(drafts).length - MAX_SESSION_DRAFT_COUNT));
    for (const [oldestKey] of oldest) delete drafts[oldestKey];

    const nextDocument: DraftDocument = {
      ...latestDocument,
      version: 2,
      nextRevision: entry === null ? latestDocument.nextRevision : entry.revision + 1,
      drafts,
    };
    if (!write(nextDocument)) return { status: "unavailable", snapshot: currentSnapshot(key) };
    return { status: "saved", snapshot: currentSnapshot(key) };
  };

  const get = (
    scopeId: string | null | undefined,
    workspaceId: string,
    sessionId: string | null | undefined,
  ) => {
    const key = sessionDraftScopeKey(scopeId, workspaceId, sessionId);
    return key ? currentSnapshot(key) : null;
  };

  /**
   * Forget the composer text. Follow-ups still waiting to be sent are not
   * composer text and stay stored until their own queue mutation removes them.
   */
  const clear = (
    scopeId: string | null | undefined,
    workspaceId: string,
    sessionId: string | null | undefined,
  ): SessionDraftWriteResult => {
    const key = sessionDraftScopeKey(scopeId, workspaceId, sessionId);
    if (!key) return { status: "unavailable", snapshot: null };
    return replaceEntry(key, (latest, revision) => {
      if (!latest || latest.queued.length === 0) return null;
      return { text: "", mode: "prompt", queued: latest.queued, revision };
    });
  };

  const save = (
    scopeId: string | null | undefined,
    workspaceId: string,
    sessionId: string | null | undefined,
    snapshot: SessionDraftSnapshot,
  ): SessionDraftWriteResult => {
    const key = sessionDraftScopeKey(scopeId, workspaceId, sessionId);
    if (!key) return { status: "unavailable", snapshot: null };
    return replaceEntry(key, (latest, revision) => {
      const entry = { text: snapshot.text, mode: snapshot.mode, queued: snapshot.queued ?? latest?.queued ?? [], revision };
      return isEmptyStoredDraft(entry) ? null : entry;
    });
  };

  /** Mirror the follow-ups waiting behind a running task under an already
   * composed draft key, leaving the composer text untouched. */
  const saveQueued = (key: string, queued: readonly string[]): SessionDraftWriteResult => {
    if (!key) return { status: "unavailable", snapshot: null };
    return replaceEntry(key, (latest, revision) => {
      const entry = { text: latest?.text ?? "", mode: latest?.mode ?? "prompt", queued: [...queued], revision };
      return isEmptyStoredDraft(entry) ? null : entry;
    });
  };

  const getRejected = (owner: RejectedTurnOwner): readonly RejectedTurn[] => loadCache().rejected[rejectedTurnOwnerKey(owner)] ?? [];
  const saveRejected = (owner: RejectedTurnOwner, turn: RejectedTurn, queue?: { remaining: string[] }): "saved" | "unavailable" => {
    const key = rejectedTurnOwnerKey(owner);
    const parsed = rejectedTurnSchema.safeParse(turn);
    if (!key || !parsed.success) return "unavailable";
    const latest = parseDocument(readRaw());
    const movedKey = JSON.stringify([key, turn.id]);
    const destination = latest.moved[movedKey] ?? key;
    const rows = latest.rejected[destination] ?? [];
    const existing = rows.find((row) => row.id === turn.id);
    const entry = existing ? { ...existing, attachments: parsed.data.attachments.some((file) => file.url) ? parsed.data.attachments : existing.attachments } : parsed.data;
    const rejected = { ...latest.rejected, [destination]: existing ? rows.map((row) => row.id === turn.id ? entry : row) : [...rows, entry] };
    const drafts = { ...latest.drafts };
    if (queue) {
      const draftKey = sessionDraftScopeKey(owner.scopeId, owner.workspaceId, owner.sessionId);
      const previous = drafts[draftKey];
      const next = { text: previous?.text ?? "", mode: previous?.mode ?? "prompt", queued: queue.remaining, revision: latest.nextRevision } satisfies StoredDraft;
      if (isEmptyStoredDraft(next)) delete drafts[draftKey]; else drafts[draftKey] = next;
    }
    return write({ ...latest, nextRevision: latest.nextRevision + 1, rejected, drafts }) ? "saved" : "unavailable";
  };
  const beginRejectedRecovery = (owner: RejectedTurnOwner, id: string, now = Date.now()) => {
    const from = rejectedTurnOwnerKey(owner);
    const latest = parseDocument(readRaw());
    if (owner.scopeId !== LOCAL_SESSION_DRAFT_SCOPE || !latest.rejected[from]?.some((turn) => turn.id === id)) return false;
    return write({ ...latest, recovery: { from, id, denBaseUrl: owner.denBaseUrl, expiresAt: now + 30 * 60_000 } });
  };
  const claimRejectedRecovery = (denBaseUrl: string, identity: SessionDraftIdentity, now = Date.now()) => {
    const latest = parseDocument(readRaw());
    const recovery = latest.recovery;
    const scope = cloudSessionDraftScope(identity);
    if (!scope || !recovery || recovery.denBaseUrl !== denBaseUrl.replace(/\/+$/, "") || recovery.expiresAt < now) return false;
    const parts = rejectedOwnerParts(recovery.from);
    const turn = latest.rejected[recovery.from]?.find((row) => row.id === recovery.id);
    if (!parts || parts[0] !== LOCAL_SESSION_DRAFT_SCOPE || parts[1] !== recovery.denBaseUrl || !turn) return false;
    const destination = JSON.stringify([scope, ...parts.slice(1)]);
    const rejected = { ...latest.rejected,
      [recovery.from]: latest.rejected[recovery.from].filter((row) => row.id !== turn.id),
      [destination]: [...(latest.rejected[destination] ?? []).filter((row) => row.id !== turn.id), turn],
    };
    if (!rejected[recovery.from].length) delete rejected[recovery.from];
    return write({ ...latest, rejected, recovery: null, moved: { ...latest.moved, [JSON.stringify([recovery.from, turn.id])]: destination } });
  };

  return {
    get,
    save,
    saveQueued,
    clear,
    getRejected,
    hasMovedRejected: (owner: RejectedTurnOwner, id: string) => Boolean(loadCache().moved[JSON.stringify([rejectedTurnOwnerKey(owner), id])]),
    saveRejected,
    beginRejectedRecovery,
    claimRejectedRecovery,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      storageCleanup?.();
      listeners.clear();
    },
  };
}

type SessionDraftStore = ReturnType<typeof createSessionDraftStore>;

let browserStore: SessionDraftStore | null = null;
let browserStorage: Storage | null = null;

function getBrowserStore(): SessionDraftStore | null {
  if (typeof window === "undefined") return null;
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return null;
  }
  if (browserStore && browserStorage === storage) return browserStore;
  browserStore?.dispose();
  browserStorage = storage;
  browserStore = createSessionDraftStore({
    storage,
    subscribeToStorage: (listener) => {
      const handleStorage = (event: StorageEvent) => listener({ key: event.key, newValue: event.newValue });
      window.addEventListener("storage", handleStorage);
      return () => window.removeEventListener("storage", handleStorage);
    },
  });
  return browserStore;
}

const subscribeBrowserDraftStore = (listener: () => void) =>
  getBrowserStore()?.subscribe(listener) ?? (() => undefined);

export const getSessionDraft = (
  scopeId: string | null | undefined,
  workspaceId: string,
  sessionId: string | null | undefined,
) => getBrowserStore()?.get(scopeId, workspaceId, sessionId) ?? null;

export const saveSessionDraft = (
  scopeId: string | null | undefined,
  workspaceId: string,
  sessionId: string | null | undefined,
  snapshot: SessionDraftSnapshot,
) => getBrowserStore()?.save(scopeId, workspaceId, sessionId, snapshot)
  ?? { status: "unavailable", snapshot: null };

export const clearSessionDraft = (
  scopeId: string | null | undefined,
  workspaceId: string,
  sessionId: string | null | undefined,
) => getBrowserStore()?.clear(scopeId, workspaceId, sessionId)
  ?? { status: "unavailable", snapshot: null };

/** `scopeKey` is a composed `sessionDraftScopeKey`, the form the composer store records per session. */
export const saveSessionQueuedDrafts = (scopeKey: string, queued: readonly string[]) =>
  getBrowserStore()?.saveQueued(scopeKey, queued) ?? { status: "unavailable", snapshot: null };

export const saveRejectedTurn = (owner: RejectedTurnOwner, turn: RejectedTurn, queue?: { remaining: string[] }) =>
  getBrowserStore()?.saveRejected(owner, turn, queue) ?? "unavailable";
export const beginRejectedTurnRecovery = (owner: RejectedTurnOwner, id: string) => getBrowserStore()?.beginRejectedRecovery(owner, id) ?? false;
export const claimRejectedTurnRecovery = (denBaseUrl: string, identity: SessionDraftIdentity) => getBrowserStore()?.claimRejectedRecovery(denBaseUrl, identity) ?? false;
export const getRejectedTurns = (owner: RejectedTurnOwner) => getBrowserStore()?.getRejected(owner) ?? [];
export const hasMovedRejectedTurn = (owner: RejectedTurnOwner, id: string) => getBrowserStore()?.hasMovedRejected(owner, id) ?? false;
export function useRejectedTurns(owner: RejectedTurnOwner) {
  const serialized = useSyncExternalStore(subscribeBrowserDraftStore, () => JSON.stringify(getRejectedTurns(owner)), () => "[]");
  return useMemo(() => z.array(rejectedTurnSchema).parse(JSON.parse(serialized)), [serialized]);
}

export function useSessionDraftState(
  scopeId: string | null | undefined,
  workspaceId: string,
  sessionId: string | null | undefined,
) {
  const key = useMemo(
    () => sessionDraftScopeKey(scopeId, workspaceId, sessionId),
    [scopeId, workspaceId, sessionId],
  );
  const serializedSnapshot = useSyncExternalStore(
    subscribeBrowserDraftStore,
    () => {
      const current = key ? getSessionDraft(scopeId, workspaceId, sessionId) : null;
      return current ? JSON.stringify(current) : "";
    },
    () => "",
  );
  const snapshot = useMemo(() => {
    if (!serializedSnapshot) return null;
    const parsed: unknown = JSON.parse(serializedSnapshot);
    if (!isRecord(parsed) || typeof parsed.text !== "string" || !isPromptMode(parsed.mode)) return null;
    const queued = parseQueued(parsed.queued);
    const snapshot: SessionDraftSnapshot = { text: parsed.text, mode: parsed.mode };
    return queued.length > 0 ? { ...snapshot, queued } : snapshot;
  }, [serializedSnapshot]);

  const save = useCallback(
    (nextSnapshot: SessionDraftSnapshot) => saveSessionDraft(scopeId, workspaceId, sessionId, nextSnapshot),
    [scopeId, workspaceId, sessionId],
  );
  const clear = useCallback(
    () => clearSessionDraft(scopeId, workspaceId, sessionId),
    [scopeId, workspaceId, sessionId],
  );

  return useMemo(
    () => ({ scopeKey: key, snapshot, save, clear }),
    [clear, key, save, snapshot],
  );
}

/**
 * The persisted prompt of a workspace's not-yet-created session. Navigating
 * to another conversation unmounts the new-task composer, so its text has to
 * outlive the component to be recoverable; the sidebar reads the same slot to
 * offer a way back.
 */
export function useNewTaskDraftState(scopeId: string | null | undefined, workspaceId: string | null | undefined, draftSessionId = NEW_TASK_DRAFT_SESSION_ID) {
  return useSessionDraftState(scopeId, workspaceId ?? "", draftSessionId);
}
