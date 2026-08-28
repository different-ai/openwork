import { describe, expect, test } from "bun:test";

import {
  cloudSessionDraftScope,
  createSessionDraftStore,
  LEGACY_SESSION_DRAFT_STORAGE_KEY,
  LOCAL_SESSION_DRAFT_SCOPE,
  MAX_SESSION_DRAFT_COUNT,
  resolveSessionDraftScope,
  SESSION_DRAFT_STORAGE_KEY,
} from "../src/react-app/domains/session/sync/draft-store";

type StorageMutation = { key: string | null; newValue: string | null };

function sharedStorageContexts() {
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<(mutation: StorageMutation) => void>>();

  const context = (id: string) => ({
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
        for (const [listenerId, contextListeners] of listeners) {
          if (listenerId === id) continue;
          for (const listener of contextListeners) listener({ key, newValue: value });
        }
      },
      removeItem: (key: string) => {
        values.delete(key);
        for (const [listenerId, contextListeners] of listeners) {
          if (listenerId === id) continue;
          for (const listener of contextListeners) listener({ key, newValue: null });
        }
      },
    },
    subscribeToStorage: (listener: (mutation: StorageMutation) => void) => {
      const contextListeners = listeners.get(id) ?? new Set<(mutation: StorageMutation) => void>();
      contextListeners.add(listener);
      listeners.set(id, contextListeners);
      return () => {
        contextListeners.delete(listener);
      };
    },
  });

  return { context, values };
}

const aliceOps = cloudSessionDraftScope({ principalId: "usr_alice", organizationId: "org_ops" });
const aliceFinance = cloudSessionDraftScope({ principalId: "usr_alice", organizationId: "org_finance" });
const bobOps = cloudSessionDraftScope({ principalId: "usr_bob", organizationId: "org_ops" });

describe("session draft storage v2", () => {
  test("makes credential changes unreadable until the new account and organization are verified", () => {
    expect(resolveSessionDraftScope({
      hasCloudCredential: true,
      verifiedIdentity: null,
    })).toBeNull();
    expect(resolveSessionDraftScope({
      hasCloudCredential: true,
      verifiedIdentity: { principalId: "usr_alice", organizationId: "org_ops" },
    })).toBe(aliceOps);
    expect(resolveSessionDraftScope({
      hasCloudCredential: true,
      verifiedIdentity: { principalId: "usr_alice", organizationId: "org_finance" },
    })).toBe(aliceFinance);
    expect(resolveSessionDraftScope({
      hasCloudCredential: true,
      verifiedIdentity: { principalId: "usr_bob", organizationId: "org_ops" },
    })).toBe(bobOps);
    expect(resolveSessionDraftScope({
      hasCloudCredential: false,
      verifiedIdentity: { principalId: "usr_alice", organizationId: "org_ops" },
    })).toBe(LOCAL_SESSION_DRAFT_SCOPE);
  });

  test("refreshes the same authorized scope without exposing it across account, organization, or local scopes", () => {
    const shared = sharedStorageContexts();
    const firstWindow = createSessionDraftStore(shared.context("first"));

    expect(aliceOps).toBeTruthy();
    expect(firstWindow.save(aliceOps, "workspace-a", "session-a", {
      text: "Alice operations draft",
      mode: "prompt",
    }).status).toBe("saved");

    firstWindow.dispose();
    const refreshedWindow = createSessionDraftStore(shared.context("refresh"));
    expect(refreshedWindow.get(aliceOps, "workspace-a", "session-a")).toEqual({
      text: "Alice operations draft",
      mode: "prompt",
    });
    expect(refreshedWindow.get(aliceFinance, "workspace-a", "session-a")).toBeNull();
    expect(refreshedWindow.get(bobOps, "workspace-a", "session-a")).toBeNull();
    expect(refreshedWindow.get(LOCAL_SESSION_DRAFT_SCOPE, "workspace-a", "session-a")).toBeNull();
    expect(refreshedWindow.get(null, "workspace-a", "session-a")).toBeNull();
  });

  test("reconciles same-scope storage events between independent windows", () => {
    const shared = sharedStorageContexts();
    const firstWindow = createSessionDraftStore(shared.context("first"));
    const secondWindow = createSessionDraftStore(shared.context("second"));
    let firstChanges = 0;
    let secondChanges = 0;
    firstWindow.subscribe(() => firstChanges += 1);
    secondWindow.subscribe(() => secondChanges += 1);

    // Load both context-local caches before either tab writes.
    expect(firstWindow.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    expect(secondWindow.get(aliceOps, "workspace-a", "session-a")).toBeNull();

    firstWindow.save(aliceOps, "workspace-a", "session-a", { text: "from first", mode: "prompt" });
    expect(secondWindow.get(aliceOps, "workspace-a", "session-a")?.text).toBe("from first");
    expect(secondChanges).toBe(1);

    secondWindow.save(aliceOps, "workspace-a", "session-a", { text: "from second", mode: "prompt" });
    expect(firstWindow.get(aliceOps, "workspace-a", "session-a")?.text).toBe("from second");
    expect(firstChanges).toBe(2);
  });

  test("does not notify subscribers when saving an unchanged draft", () => {
    const shared = sharedStorageContexts();
    const store = createSessionDraftStore(shared.context("writer"));
    let changes = 0;
    store.subscribe(() => changes += 1);

    store.save(aliceOps, "workspace-a", "session-a", { text: "stable", mode: "prompt" });
    const firstSnapshot = store.get(aliceOps, "workspace-a", "session-a");
    const changesAfterInitialSave = changes;
    const result = store.save(aliceOps, "workspace-a", "session-a", { text: "stable", mode: "prompt" });

    expect(result).toEqual({ status: "saved", snapshot: firstSnapshot });
    expect(store.get(aliceOps, "workspace-a", "session-a")).toBe(firstSnapshot);
    expect(changes).toBe(changesAfterInitialSave);
  });

  test("rejects a stale writer instead of silently overwriting a newer stored draft", () => {
    const shared = sharedStorageContexts();
    const firstContext = shared.context("first");
    const staleContext = shared.context("stale");
    const firstWindow = createSessionDraftStore({ storage: firstContext.storage });
    const staleWindow = createSessionDraftStore({ storage: staleContext.storage });

    expect(firstWindow.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    expect(staleWindow.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    firstWindow.save(aliceOps, "workspace-a", "session-a", { text: "newer", mode: "prompt" });

    const conflict = staleWindow.save(aliceOps, "workspace-a", "session-a", {
      text: "stale overwrite",
      mode: "prompt",
    });
    expect(conflict).toEqual({
      status: "conflict",
      snapshot: { text: "newer", mode: "prompt" },
    });
    expect(firstWindow.get(aliceOps, "workspace-a", "session-a")?.text).toBe("newer");
  });

  test("clear removes only the exact draft and a stale clear preserves a newer revision", () => {
    const shared = sharedStorageContexts();
    const writer = createSessionDraftStore(shared.context("writer"));
    writer.save(aliceOps, "workspace-a", "session-a", { text: "target", mode: "prompt" });
    writer.save(aliceOps, "workspace-a", "session-b", { text: "other session", mode: "prompt" });
    writer.save(aliceOps, "workspace-b", "session-a", { text: "other workspace", mode: "prompt" });
    writer.save(bobOps, "workspace-a", "session-a", { text: "other account", mode: "prompt" });

    expect(writer.clear(aliceOps, "workspace-a", "session-a").status).toBe("saved");
    expect(writer.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    expect(writer.get(aliceOps, "workspace-a", "session-b")?.text).toBe("other session");
    expect(writer.get(aliceOps, "workspace-b", "session-a")?.text).toBe("other workspace");
    expect(writer.get(bobOps, "workspace-a", "session-a")?.text).toBe("other account");

    writer.save(aliceOps, "workspace-a", "session-a", { text: "before send", mode: "prompt" });
    const staleContext = shared.context("stale");
    const staleWindow = createSessionDraftStore({ storage: staleContext.storage });
    expect(staleWindow.get(aliceOps, "workspace-a", "session-a")?.text).toBe("before send");
    writer.save(aliceOps, "workspace-a", "session-a", { text: "newer tab edit", mode: "prompt" });

    expect(staleWindow.clear(aliceOps, "workspace-a", "session-a")).toEqual({
      status: "conflict",
      snapshot: { text: "newer tab edit", mode: "prompt" },
    });
    expect(writer.get(aliceOps, "workspace-a", "session-a")?.text).toBe("newer tab edit");
  });

  test("keeps unsigned local drafts usable and separate", () => {
    const shared = sharedStorageContexts();
    const store = createSessionDraftStore(shared.context("local"));
    store.save(LOCAL_SESSION_DRAFT_SCOPE, "workspace-local", "session-local", {
      text: "local draft",
      mode: "prompt",
    });

    expect(store.get(LOCAL_SESSION_DRAFT_SCOPE, "workspace-local", "session-local")?.text).toBe("local draft");
    expect(store.get(aliceOps, "workspace-local", "session-local")).toBeNull();
  });

  test("drops ambiguous legacy v1 data without broadening who may read it", () => {
    const shared = sharedStorageContexts();
    shared.values.set(LEGACY_SESSION_DRAFT_STORAGE_KEY, JSON.stringify({
      "workspace-a:session-a": { text: "unknown former owner", mode: "prompt" },
    }));
    const store = createSessionDraftStore(shared.context("migration"));

    expect(store.get(LOCAL_SESSION_DRAFT_SCOPE, "workspace-a", "session-a")).toBeNull();
    expect(store.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    expect(shared.values.has(LEGACY_SESSION_DRAFT_STORAGE_KEY)).toBe(false);
  });

  test("evicts only the least-recently-written drafts over the bounded limit", () => {
    const shared = sharedStorageContexts();
    const store = createSessionDraftStore(shared.context("eviction"));
    for (let index = 0; index <= MAX_SESSION_DRAFT_COUNT; index += 1) {
      expect(store.save(aliceOps, "workspace-a", `session-${index}`, {
        text: `draft-${index}`,
        mode: "prompt",
      }).status).toBe("saved");
    }

    expect(store.get(aliceOps, "workspace-a", "session-0")).toBeNull();
    expect(store.get(aliceOps, "workspace-a", "session-1")?.text).toBe("draft-1");
    expect(store.get(aliceOps, "workspace-a", `session-${MAX_SESSION_DRAFT_COUNT}`)?.text)
      .toBe(`draft-${MAX_SESSION_DRAFT_COUNT}`);
  });

  test("treats malformed data as empty and repairs it on the next valid save", () => {
    const shared = sharedStorageContexts();
    shared.values.set(SESSION_DRAFT_STORAGE_KEY, "{not-json");
    const store = createSessionDraftStore(shared.context("malformed"));

    expect(store.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    expect(store.save(aliceOps, "workspace-a", "session-a", {
      text: "recovered",
      mode: "prompt",
    }).status).toBe("saved");
    expect(() => JSON.parse(shared.values.get(SESSION_DRAFT_STORAGE_KEY) ?? "")).not.toThrow();
    expect(store.get(aliceOps, "workspace-a", "session-a")?.text).toBe("recovered");
  });

  test("never crashes when reads, migration, or quota-limited writes fail", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage denied");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage denied");
      },
    };
    const store = createSessionDraftStore({ storage: unavailableStorage });

    expect(() => store.get(aliceOps, "workspace-a", "session-a")).not.toThrow();
    expect(store.get(aliceOps, "workspace-a", "session-a")).toBeNull();
    expect(store.save(aliceOps, "workspace-a", "session-a", {
      text: "cannot persist",
      mode: "prompt",
    }).status).toBe("unavailable");
    expect(store.clear(aliceOps, "workspace-a", "session-a").status).toBe("saved");
  });
});
