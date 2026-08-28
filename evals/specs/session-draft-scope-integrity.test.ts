import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  cloudSessionDraftScope,
  createSessionDraftStore,
  LEGACY_SESSION_DRAFT_STORAGE_KEY,
  LOCAL_SESSION_DRAFT_SCOPE,
  resolveSessionDraftScope,
  SESSION_DRAFT_STORAGE_KEY,
} from "../../apps/app/src/react-app/domains/session/sync/draft-store";

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

test("composer drafts stay private per identity and safe under concurrent tabs", ({ evidence }) => {
  const shared = sharedStorageContexts();

  // Claim: a draft written under one verified identity survives a reload and
  // is readable again by exactly that identity.
  const firstWindow = createSessionDraftStore(shared.context("first"));
  expect(aliceOps).toBeTruthy();
  expect(firstWindow.save(aliceOps, "workspace-a", "session-a", {
    text: "Alice operations draft",
    mode: "prompt",
  }).status).toBe("saved");
  firstWindow.dispose();
  const reloaded = createSessionDraftStore(shared.context("reload"));
  expect(reloaded.get(aliceOps, "workspace-a", "session-a")).toEqual({
    text: "Alice operations draft",
    mode: "prompt",
  });

  // Negative half 1 (identity and organization transitions): a different
  // account, a different organization of the same account, the unsigned
  // local scope, and an unverified credential (null scope) each read nothing.
  expect(reloaded.get(bobOps, "workspace-a", "session-a")).toBeNull();
  expect(reloaded.get(aliceFinance, "workspace-a", "session-a")).toBeNull();
  expect(reloaded.get(LOCAL_SESSION_DRAFT_SCOPE, "workspace-a", "session-a")).toBeNull();
  expect(reloaded.get(null, "workspace-a", "session-a")).toBeNull();

  // Scope resolution: a cloud credential without a verified identity resolves
  // to no scope at all — drafts become inaccessible the moment the verified
  // identity or organization changes, not after the next round trip.
  expect(resolveSessionDraftScope({ hasCloudCredential: true, verifiedIdentity: null })).toBeNull();
  expect(resolveSessionDraftScope({
    hasCloudCredential: true,
    verifiedIdentity: { principalId: "usr_alice", organizationId: "org_ops" },
  })).toBe(aliceOps);
  expect(resolveSessionDraftScope({
    hasCloudCredential: false,
    verifiedIdentity: { principalId: "usr_alice", organizationId: "org_ops" },
  })).toBe(LOCAL_SESSION_DRAFT_SCOPE);

  // Claim: two live tabs reconcile through storage events — the second tab
  // observes the first tab's write without a reload.
  const tabA = createSessionDraftStore(shared.context("tab-a"));
  const tabB = createSessionDraftStore(shared.context("tab-b"));
  let tabBChanges = 0;
  tabB.subscribe(() => {
    tabBChanges += 1;
  });
  expect(tabB.get(aliceOps, "workspace-a", "session-b")).toBeNull();
  tabA.save(aliceOps, "workspace-a", "session-b", { text: "from tab A", mode: "prompt" });
  expect(tabB.get(aliceOps, "workspace-a", "session-b")?.text).toBe("from tab A");
  expect(tabBChanges).toBe(1);

  // Negative half 2 (render stability): persisting the same composer value is
  // a no-op. It retains the observable snapshot identity and does not notify
  // subscribers, preventing a persistence/render feedback loop.
  const stableSnapshot = tabA.get(aliceOps, "workspace-a", "session-b");
  let tabAChanges = 0;
  tabA.subscribe(() => {
    tabAChanges += 1;
  });
  expect(tabA.save(aliceOps, "workspace-a", "session-b", { text: "from tab A", mode: "prompt" }))
    .toEqual({ status: "saved", snapshot: stableSnapshot });
  expect(tabA.get(aliceOps, "workspace-a", "session-b")).toBe(stableSnapshot);
  expect(tabAChanges).toBe(0);

  // Negative half 3 (stale writes): a tab holding an old revision can neither
  // overwrite a newer draft nor clear it; both operations surface the newer
  // snapshot as a conflict instead of silently losing it. After observing a
  // conflict the tab is resynchronized, so its next operation acts on the
  // newer revision intentionally rather than accidentally.
  const staleSaveTab = createSessionDraftStore({ storage: shared.context("stale-save").storage });
  const staleClearTab = createSessionDraftStore({ storage: shared.context("stale-clear").storage });
  expect(staleSaveTab.get(aliceOps, "workspace-a", "session-b")?.text).toBe("from tab A");
  expect(staleClearTab.get(aliceOps, "workspace-a", "session-b")?.text).toBe("from tab A");
  tabA.save(aliceOps, "workspace-a", "session-b", { text: "newer edit", mode: "prompt" });
  expect(staleSaveTab.save(aliceOps, "workspace-a", "session-b", {
    text: "stale overwrite",
    mode: "prompt",
  })).toEqual({ status: "conflict", snapshot: { text: "newer edit", mode: "prompt" } });
  expect(staleClearTab.clear(aliceOps, "workspace-a", "session-b")).toEqual({
    status: "conflict",
    snapshot: { text: "newer edit", mode: "prompt" },
  });
  expect(tabA.get(aliceOps, "workspace-a", "session-b")?.text).toBe("newer edit");
  // Post-conflict recovery: the resynchronized tab may now clear on purpose.
  expect(staleClearTab.clear(aliceOps, "workspace-a", "session-b").status).toBe("saved");
  expect(tabA.get(aliceOps, "workspace-a", "session-b")).toBeNull();

  // Negative half 4 (legacy storage): v1 drafts carry no identity boundary,
  // so they are dropped fail-closed instead of being exposed to any scope.
  const legacy = sharedStorageContexts();
  legacy.values.set(LEGACY_SESSION_DRAFT_STORAGE_KEY, JSON.stringify({
    "workspace-a:session-a": { text: "unknown former owner", mode: "prompt" },
  }));
  const migrated = createSessionDraftStore(legacy.context("migration"));
  expect(migrated.get(LOCAL_SESSION_DRAFT_SCOPE, "workspace-a", "session-a")).toBeNull();
  expect(migrated.get(aliceOps, "workspace-a", "session-a")).toBeNull();
  expect(legacy.values.has(LEGACY_SESSION_DRAFT_STORAGE_KEY)).toBe(false);

  // Negative half 5 (untrusted storage): malformed documents read as empty
  // and repair on the next valid save; a storage that throws never crashes
  // the composer and reports the write as unavailable rather than saved.
  const corrupt = sharedStorageContexts();
  corrupt.values.set(SESSION_DRAFT_STORAGE_KEY, "{not-json");
  const repaired = createSessionDraftStore(corrupt.context("repair"));
  expect(repaired.get(aliceOps, "workspace-a", "session-a")).toBeNull();
  expect(repaired.save(aliceOps, "workspace-a", "session-a", {
    text: "recovered",
    mode: "prompt",
  }).status).toBe("saved");
  const denied = createSessionDraftStore({
    storage: {
      getItem: () => {
        throw new Error("storage denied");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage denied");
      },
    },
  });
  expect(denied.get(aliceOps, "workspace-a", "session-a")).toBeNull();
  expect(denied.save(aliceOps, "workspace-a", "session-a", {
    text: "cannot persist",
    mode: "prompt",
  }).status).toBe("unavailable");

  evidence.recordAssertionEvidence(
    "Composer drafts are private and conflict-safe",
    "Drafts survive reloads within one verified identity scope; other accounts, organizations, the local scope, and unverified credentials read nothing; concurrent tabs reconcile via storage events; unchanged saves preserve snapshot identity without notifying subscribers; stale writers and clears conflict instead of overwriting; legacy v1 data is dropped fail-closed; corrupt or denied storage degrades safely.",
    true,
  );
});
