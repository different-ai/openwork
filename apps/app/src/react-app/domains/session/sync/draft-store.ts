/** @jsxImportSource react */
import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { PromptMode } from "../../../../app/types";

export type SessionDraftSnapshot = {
  text: string;
  mode: PromptMode;
};

export type SessionDraftIdentity = {
  principalId: string;
  organizationId: string;
};

export type SessionDraftWriteResult =
  | { status: "saved"; snapshot: SessionDraftSnapshot | null }
  | { status: "conflict"; snapshot: SessionDraftSnapshot | null }
  | { status: "unavailable"; snapshot: SessionDraftSnapshot | null };

type StoredDraft = SessionDraftSnapshot & {
  revision: number;
};

type DraftDocument = {
  version: 2;
  nextRevision: number;
  drafts: Record<string, StoredDraft>;
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

const EMPTY_DOCUMENT: DraftDocument = {
  version: 2,
  nextRevision: 1,
  drafts: {},
};

const isPromptMode = (value: unknown): value is PromptMode =>
  value === "prompt" || value === "shell";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedOpaqueId = (value: string) => encodeURIComponent(value.trim());

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
      if (!value.text && value.mode === "prompt") continue;
      drafts[key] = { text: value.text, mode: value.mode, revision: value.revision };
      highestRevision = Math.max(highestRevision, value.revision);
    }

    const declaredNextRevision = typeof parsed.nextRevision === "number"
      && Number.isSafeInteger(parsed.nextRevision)
      && parsed.nextRevision > 0
      ? parsed.nextRevision
      : 1;

    return {
      version: 2,
      nextRevision: Math.max(declaredNextRevision, highestRevision + 1),
      drafts,
    };
  } catch {
    return EMPTY_DOCUMENT;
  }
}

function sameStoredDraft(left: StoredDraft | undefined, right: StoredDraft | undefined) {
  if (!left || !right) return left === right;
  return left.revision === right.revision
    && left.text === right.text
    && left.mode === right.mode;
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
    const snapshot = { text: stored.text, mode: stored.mode };
    visibleSnapshots.set(stored, snapshot);
    return snapshot;
  };

  const get = (
    scopeId: string | null | undefined,
    workspaceId: string,
    sessionId: string | null | undefined,
  ) => {
    const key = sessionDraftScopeKey(scopeId, workspaceId, sessionId);
    return key ? currentSnapshot(key) : null;
  };

  const clear = (
    scopeId: string | null | undefined,
    workspaceId: string,
    sessionId: string | null | undefined,
  ): SessionDraftWriteResult => {
    const key = sessionDraftScopeKey(scopeId, workspaceId, sessionId);
    if (!key) return { status: "unavailable", snapshot: null };

    const expected = loadCache().drafts[key];
    const latestDocument = parseDocument(readRaw());
    const latest = latestDocument.drafts[key];
    if (!sameStoredDraft(expected, latest)) {
      replaceCache(latestDocument);
      return { status: "conflict", snapshot: currentSnapshot(key) };
    }
    if (!latest) return { status: "saved", snapshot: null };

    const drafts = { ...latestDocument.drafts };
    delete drafts[key];
    const nextDocument: DraftDocument = { ...latestDocument, drafts };
    if (!write(nextDocument)) return { status: "unavailable", snapshot: currentSnapshot(key) };
    return { status: "saved", snapshot: null };
  };

  const save = (
    scopeId: string | null | undefined,
    workspaceId: string,
    sessionId: string | null | undefined,
    snapshot: SessionDraftSnapshot,
  ): SessionDraftWriteResult => {
    const key = sessionDraftScopeKey(scopeId, workspaceId, sessionId);
    if (!key) return { status: "unavailable", snapshot: null };
    if (!snapshot.text && snapshot.mode === "prompt") {
      return clear(scopeId, workspaceId, sessionId);
    }

    const expected = loadCache().drafts[key];
    const latestDocument = parseDocument(readRaw());
    const latest = latestDocument.drafts[key];
    if (!sameStoredDraft(expected, latest)) {
      replaceCache(latestDocument);
      return { status: "conflict", snapshot: currentSnapshot(key) };
    }
    if (latest?.text === snapshot.text && latest.mode === snapshot.mode) {
      return { status: "saved", snapshot: currentSnapshot(key) };
    }

    const revision = latestDocument.nextRevision;
    const drafts = {
      ...latestDocument.drafts,
      [key]: { text: snapshot.text, mode: snapshot.mode, revision },
    };
    const oldest = Object.entries(drafts)
      .sort((left, right) => left[1].revision - right[1].revision)
      .slice(0, Math.max(0, Object.keys(drafts).length - MAX_SESSION_DRAFT_COUNT));
    for (const [oldestKey] of oldest) delete drafts[oldestKey];

    const nextDocument: DraftDocument = {
      version: 2,
      nextRevision: revision + 1,
      drafts,
    };
    const normalized = { text: snapshot.text, mode: snapshot.mode };
    if (!write(nextDocument)) return { status: "unavailable", snapshot: currentSnapshot(key) };
    return { status: "saved", snapshot: normalized };
  };

  return {
    get,
    save,
    clear,
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
    return { text: parsed.text, mode: parsed.mode };
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
