import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import {
  createActivityStore,
  EMPTY_ACTIVITY_CONTEXT,
  PERSISTED_ACTIVITY_STORE_KEY,
  selectActivityContext,
} from "../src/react-app/kernel/activity-store";
import { activityScopeKey, type ActivityResource, type ActivityScope } from "../src/react-app/kernel/activity-types";

const scope: ActivityScope = {
  baseUrl: "https://cloud.example.test",
  organizationId: "org_one",
  memberId: "member_one",
};

const provider: ActivityResource = {
  id: "provider_one",
  kind: "provider",
  label: "Team models",
  revision: null,
  href: "/settings/providers",
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

afterEach(() => setSystemTime());

describe("member Activity store", () => {
  test("unavailable device storage does not interrupt observations in memory", () => {
    const store = createActivityStore({
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { throw new Error("storage full"); },
      removeItem: () => {},
    });
    expect(() => {
      store.getState().setScope(scope);
      store.getState().observe({ scope, source: "providers", resources: [] });
      store.getState().observe({ scope, source: "providers", resources: [provider] });
    }).not.toThrow();
    expect(selectActivityContext(store.getState()).entries.map((entry) => entry.change)).toEqual(["available"]);
  });

  test("incomplete identities and credential-bearing server URLs cannot select or persist an account", () => {
    const storage = memoryStorage();
    const store = createActivityStore(storage);
    for (const invalid of [
      { ...scope, memberId: "" },
      { ...scope, organizationId: "" },
      { ...scope, baseUrl: "" },
      { ...scope, baseUrl: "https://member:must-not-persist@cloud.example.test" },
      { ...scope, baseUrl: "https://cloud.example.test?token=must-not-persist" },
    ]) {
      store.getState().setScope(invalid);
      store.getState().observe({ scope: invalid, source: "providers", resources: [provider] });
      expect(store.getState().activeScopeKey).toBeNull();
      expect(store.getState().contexts).toEqual({});
      expect(selectActivityContext(store.getState())).toBe(EMPTY_ACTIVITY_CONTEXT);
    }
    expect(storage.getItem(PERSISTED_ACTIVITY_STORE_KEY)).not.toContain("must-not-persist");
  });

  test("unknown or malformed persistence versions never restore a baseline", () => {
    for (const version of [undefined, null, "1", 2]) {
      const storage = memoryStorage();
      storage.setItem(PERSISTED_ACTIVITY_STORE_KEY, JSON.stringify({
        version,
        state: { contexts: { [activityScopeKey(scope)]: {
          entries: [], snapshots: { providers: [provider] }, verifiedAt: Date.now(),
        } } },
      }));
      const store = createActivityStore(storage);
      store.getState().setScope(scope);
      expect(selectActivityContext(store.getState())).toBe(EMPTY_ACTIVITY_CONTEXT);
      store.getState().observe({ scope, source: "providers", resources: [] });
      expect(selectActivityContext(store.getState()).entries).toEqual([]);
    }
  });

  test("malformed delayed storage still completes hydration and applies queued successful snapshots", async () => {
    const storage = memoryStorage();
    let finishRead = (_value: string | null) => {};
    const pendingRead = new Promise<string | null>((resolve) => { finishRead = resolve; });
    const store = createActivityStore({ ...storage, getItem: () => pendingRead });
    store.getState().setScope(scope);
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    const hydrated = store.persist.rehydrate();
    finishRead("{broken-json");
    await hydrated;

    expect(store.persist.hasHydrated()).toBe(true);
    expect(selectActivityContext(store.getState()).entries.map((entry) => entry.change)).toEqual(["available"]);
    expect(selectActivityContext(store.getState()).snapshots.providers).toEqual([provider]);
  });

  test("an identity switch invalidates queued observations even if the member switches back before hydration", async () => {
    const storage = memoryStorage();
    const original = createActivityStore(storage);
    original.getState().setScope(scope);
    original.getState().observe({ scope, source: "providers", resources: [] });
    original.getState().observe({ scope, source: "providers", resources: [provider] });
    const saved = storage.getItem(PERSISTED_ACTIVITY_STORE_KEY);
    let finishRead = (_value: string | null) => {};
    const pendingRead = new Promise<string | null>((resolve) => { finishRead = resolve; });
    const store = createActivityStore({ ...storage, getItem: () => pendingRead });
    const hydrated = new Promise<void>((resolve) => { store.persist.onFinishHydration(() => resolve()); });
    store.getState().setScope(scope);
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().setScope({ ...scope, memberId: "member_two" });
    store.getState().setScope(scope);
    finishRead(saved);
    await hydrated;
    expect(selectActivityContext(store.getState()).entries.map((entry) => entry.change)).toEqual(["available"]);
    expect(selectActivityContext(store.getState()).snapshots.providers).toEqual([provider]);
  });

  test("observations store only safe resource descriptors and reject an invalid inventory as a whole", () => {
    const storage = memoryStorage();
    const store = createActivityStore(storage);
    store.getState().setScope(scope);
    store.getState().observe({ scope, source: "providers", resources: [] });
    const input = { ...provider, token: "must-not-persist", raw: { credentials: "must-not-persist" } };
    store.getState().observe({ scope, source: "providers", resources: [input] });
    input.label = "Changed outside the store";
    const context = selectActivityContext(store.getState());
    expect(context.entries[0].resource).toEqual(provider);
    expect(storage.getItem(PERSISTED_ACTIVITY_STORE_KEY)).not.toContain("must-not-persist");

    for (const observedAt of [Date.now() + 60_000, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      store.getState().observe({ scope, source: "providers", resources: [], observedAt });
    }
    for (const href of ["https://outside.example.test", "//outside.example.test", "/\\outside.example.test"]) {
      store.getState().observe({ scope, source: "providers", resources: [{ ...provider, id: "other", href }] });
    }
    store.getState().observe({ scope, source: "providers", resources: [{ ...provider, label: "" }] });
    store.getState().setRefreshState(scope, "error");
    expect(selectActivityContext(store.getState())).toEqual(context);
  });

  test("hydration rejects corrupt fields, future timestamps and unsafe links while retaining valid history", () => {
    const storage = memoryStorage();
    const now = Date.now();
    const valid = { id: "entry_valid", resource: provider, change: "available", observedAt: now - 1_000 };
    const plugin: ActivityResource = { id: "plugin_one", kind: "plugin", label: "Team tools", revision: "1", href: "/plugins" };
    storage.setItem(PERSISTED_ACTIVITY_STORE_KEY, JSON.stringify({
      version: 1,
      state: {
        activeScopeKey: activityScopeKey(scope),
        refreshState: "error",
        contexts: {
          [activityScopeKey(scope)]: {
            entries: [
              { ...valid, readAt: now, unread: true, raw: { token: "must-not-persist" } },
              { ...valid, id: "future", observedAt: now + 60_000 },
              { ...valid, id: "negative", observedAt: -1 },
              { ...valid, id: "corrupt", resource: { id: "missing-fields" } },
              ...["https://outside.example.test", "//outside.example.test", "/\\outside.example.test"].map((href, index) => ({
                ...valid, id: `unsafe_${index}`, resource: { ...provider, href },
              })),
            ],
            snapshots: {
              providers: [{ ...provider, href: "//outside.example.test" }],
              capabilities: [plugin, { ...plugin, raw: "must-not-persist" }],
              unknown: [provider],
            },
            verifiedAt: now + 60_000,
            unread: true,
          },
          [activityScopeKey({ ...scope, memberId: "broken" })]: "corrupt",
          "not-a-scope": { entries: [valid], snapshots: {}, verifiedAt: now },
        },
      },
    }));

    const store = createActivityStore(storage);
    expect(store.getState().activeScopeKey).toBeNull();
    expect(store.getState().refreshState).toBe("idle");
    store.getState().setScope(scope);
    expect(selectActivityContext(store.getState())).toEqual({
      entries: [valid], snapshots: { capabilities: [plugin] }, verifiedAt: null, seenAt: null, baseline: null,
    });
    expect(Object.keys(store.getState().contexts)).toEqual([activityScopeKey(scope)]);
    expect(storage.getItem(PERSISTED_ACTIVITY_STORE_KEY)).not.toContain("must-not-persist");
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    expect(selectActivityContext(store.getState()).entries).toEqual([valid]);
  });

  test("only the five most recently used account contexts survive writes and reloads", () => {
    const storage = memoryStorage();
    const store = createActivityStore(storage);
    const scopes = Array.from({ length: 6 }, (_, index) => ({ ...scope, memberId: `member_${index}` }));
    for (const memberScope of scopes.slice(0, 5)) {
      store.getState().setScope(memberScope);
      store.getState().observe({ scope: memberScope, source: "providers", resources: [] });
      store.getState().observe({ scope: memberScope, source: "providers", resources: [provider] });
    }
    store.getState().setScope(scopes[0]);
    const recentHistory = selectActivityContext(store.getState()).entries;
    store.getState().setScope(scopes[5]);
    store.getState().observe({ scope: scopes[5], source: "providers", resources: [] });

    expect(Object.keys(store.getState().contexts)).toHaveLength(5);
    expect(store.getState().contexts[activityScopeKey(scopes[1])]).toBeUndefined();
    expect(store.getState().contexts[activityScopeKey(scopes[0])].entries).toEqual(recentHistory);
    const restored = createActivityStore(storage);
    expect(Object.keys(restored.getState().contexts)).toHaveLength(5);
    restored.getState().setScope(scopes[0]);
    expect(selectActivityContext(restored.getState()).entries).toEqual(recentHistory);
  });

  test("30-day history expiry prunes on writes, scope selection and hydration without forgetting baselines", () => {
    const now = Date.now();
    for (const action of ["observe", "select", "reload", "refresh"]) {
      setSystemTime(now);
      const storage = memoryStorage();
      const original = createActivityStore(storage);
      original.getState().setScope(scope);
      original.getState().observe({ scope, source: "providers", resources: [] });
      original.getState().observe({ scope, source: "providers", resources: [provider] });
      setSystemTime(now + 31 * 24 * 60 * 60 * 1_000);
      const store = action === "reload" ? createActivityStore(storage) : original;
      if (action === "observe") store.getState().observe({ scope, source: "providers", resources: [provider] });
      if (action === "select") store.getState().setScope(scope);
      if (action === "refresh") store.getState().setRefreshState(scope, "refreshing");
      expect(store.getState().contexts[activityScopeKey(scope)].entries).toEqual([]);
      store.getState().setScope(scope);
      store.getState().observe({ scope, source: "providers", resources: [provider] });
      expect(selectActivityContext(store.getState()).entries).toEqual([]);
      expect(selectActivityContext(store.getState()).snapshots.providers).toEqual([provider]);
      store.getState().observe({ scope, source: "providers", resources: [] });
      expect(selectActivityContext(store.getState()).entries.map((entry) => entry.change)).toEqual(["unavailable"]);
    }
  });

  test("history keeps the 100 newest observations without truncating source baselines", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    store.getState().observe({ scope, source: "providers", resources: [] });
    const resources: ActivityResource[] = [];
    const startedAt = Date.now() - 1_000;
    for (let index = 0; index < 105; index += 1) {
      resources.push({ ...provider, id: `provider_${index}` });
      store.getState().observe({ scope, source: "providers", resources: [...resources], observedAt: startedAt + index });
    }
    const context = selectActivityContext(store.getState());
    expect(context.entries).toHaveLength(100);
    expect(context.entries[0].resource.id).toBe("provider_104");
    expect(context.entries[99].resource.id).toBe("provider_5");
    expect(context.snapshots.providers).toHaveLength(105);
    store.getState().observe({ scope, source: "providers", resources });
    expect(selectActivityContext(store.getState()).entries).toEqual(context.entries);
  });

  test("selecting a scope and receiving a snapshot before hydration preserves persisted history", async () => {
    const storage = memoryStorage();
    const original = createActivityStore(storage);
    original.getState().setScope(scope);
    original.getState().observe({ scope, source: "providers", resources: [] });
    original.getState().observe({ scope, source: "providers", resources: [provider] });
    const saved = storage.getItem(PERSISTED_ACTIVITY_STORE_KEY);
    let finishRead = (_value: string | null) => {};
    const pendingRead = new Promise<string | null>((resolve) => { finishRead = resolve; });
    const restored = createActivityStore({ ...storage, getItem: () => pendingRead });
    const hydrated = new Promise<void>((resolve) => { restored.persist.onFinishHydration(() => resolve()); });

    restored.getState().setScope(scope);
    restored.getState().setRefreshState(scope, "refreshing");
    restored.getState().observe({ scope, source: "providers", resources: [] });
    expect(storage.getItem(PERSISTED_ACTIVITY_STORE_KEY)).toBe(saved);
    finishRead(saved);
    await hydrated;

    expect(restored.getState().activeScopeKey).toBe(activityScopeKey(scope));
    expect(restored.getState().refreshState).toBe("refreshing");
    expect(selectActivityContext(restored.getState()).entries.map((entry) => entry.change)).toEqual([
      "unavailable", "available",
    ]);
    expect(selectActivityContext(restored.getState()).snapshots.providers).toEqual([]);
  });

  test("reload restores only scoped history and baselines, never active identity or status", () => {
    const storage = memoryStorage();
    const original = createActivityStore(storage);
    original.getState().setScope(scope);
    original.getState().observe({ scope, source: "providers", resources: [] });
    original.getState().observe({ scope, source: "providers", resources: [provider] });
    original.getState().setRefreshState(scope, "error");
    const history = selectActivityContext(original.getState()).entries;

    const restored = createActivityStore(storage);
    expect(restored.getState().activeScopeKey).toBeNull();
    expect(restored.getState().refreshState).toBe("idle");
    expect(selectActivityContext(restored.getState())).toBe(EMPTY_ACTIVITY_CONTEXT);
    restored.getState().setScope(scope);
    expect(selectActivityContext(restored.getState()).entries).toEqual(history);
    restored.getState().observe({ scope, source: "providers", resources: [provider] });
    expect(selectActivityContext(restored.getState()).entries).toEqual(history);

    expect(JSON.parse(storage.getItem(PERSISTED_ACTIVITY_STORE_KEY) ?? "null")).toEqual({
      state: { contexts: restored.getState().contexts },
      version: 1,
    });
    expect(history[0]).not.toHaveProperty("readAt");
    expect(history[0]).not.toHaveProperty("unread");
  });

  test("server, organization and member scopes isolate history and reject inactive deliveries", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    expect(store.getState().contexts).toEqual({});
    store.getState().setScope(scope);
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    const history = selectActivityContext(store.getState()).entries;

    for (const other of [
      { ...scope, baseUrl: "https://other.example.test" },
      { ...scope, organizationId: "org_two" },
      { ...scope, memberId: "member_two" },
    ]) {
      store.getState().setScope(other);
      expect(selectActivityContext(store.getState()).entries).toEqual([]);
      store.getState().setRefreshState(other, "refreshing");
      store.getState().observe({ scope, source: "providers", resources: [] });
      store.getState().setRefreshState(scope, "error");
      expect(store.getState().refreshState).toBe("refreshing");
      store.getState().observe({ scope: other, source: "providers", resources: [provider] });
      expect(selectActivityContext(store.getState()).entries).toEqual([]);
      store.getState().setScope({ ...scope, baseUrl: `${scope.baseUrl}/` });
      expect(selectActivityContext(store.getState()).entries).toEqual(history);
      expect(store.getState().refreshState).toBe("idle");
    }

    store.getState().setScope(null);
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().setRefreshState(scope, "error");
    expect(selectActivityContext(store.getState())).toBe(EMPTY_ACTIVITY_CONTEXT);
    expect(store.getState().refreshState).toBe("idle");
    store.getState().setScope(scope);
    expect(selectActivityContext(store.getState()).entries).toEqual(history);
  });

  test("removal keeps the last known label and regrant is a new event without removing other sources", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    const plugin: ActivityResource = { id: "plugin_one", kind: "plugin", label: "Team tools", revision: "1", href: "/plugins" };
    store.getState().observe({ scope, source: "capabilities", resources: [plugin] });
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    const renamed = { ...provider, label: "Shared models" };
    store.getState().observe({ scope, source: "providers", resources: [renamed] });
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    store.getState().observe({ scope, source: "capabilities", resources: [plugin] });

    const context = selectActivityContext(store.getState());
    expect(context.entries.map((entry) => [entry.change, entry.resource.label])).toEqual([
      ["available", "Team models"],
      ["unavailable", "Shared models"],
    ]);
    expect(new Set(context.entries.map((entry) => entry.id)).size).toBe(2);
    expect(context.snapshots.capabilities).toEqual([plugin]);
  });

  test("updates describe skill, plugin and connection content, not provider availability metadata", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    const plugin: ActivityResource = { id: "plugin_one", kind: "plugin", label: "Team tools", revision: "1", href: "/plugins" };
    const connection: ActivityResource = { id: "connection_one", kind: "connection", label: "Calendar", revision: "1", href: "/settings/connections" };
    store.getState().observe({ scope, source: "capabilities", resources: [plugin] });
    store.getState().observe({ scope, source: "providers", resources: [{ ...provider, revision: "1" }] });
    store.getState().observe({ scope, source: "connections", resources: [connection] });
    store.getState().observe({ scope, source: "capabilities", resources: [{ ...plugin, revision: "2" }] });
    store.getState().observe({ scope, source: "providers", resources: [{ ...provider, revision: "2" }] });
    store.getState().observe({ scope, source: "connections", resources: [{ ...connection, revision: "2" }] });

    expect(selectActivityContext(store.getState()).entries.map((entry) => [entry.change, entry.resource.kind])).toEqual([
      ["updated", "connection"],
      ["updated", "plugin"],
    ]);
  });

  test("known content revisions produce updates, but cosmetic and unknown revisions do not", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    const skill: ActivityResource = { id: "skill_one", kind: "skill", label: "Summarize", revision: null, href: "/skills" };
    store.getState().observe({ scope, source: "capabilities", resources: [skill] });
    store.getState().observe({ scope, source: "capabilities", resources: [{ ...skill, revision: "1" }] });
    const renamed = { ...skill, label: "Summary", href: "/skills/skill_one", revision: "1" };
    store.getState().observe({ scope, source: "capabilities", resources: [renamed] });
    expect(selectActivityContext(store.getState()).entries).toEqual([]);
    expect(selectActivityContext(store.getState()).snapshots.capabilities).toEqual([renamed]);

    store.getState().observe({ scope, source: "capabilities", resources: [{ ...renamed, revision: "2" }] });
    store.getState().observe({ scope, source: "capabilities", resources: [{ ...renamed, revision: "2" }] });
    store.getState().observe({ scope, source: "capabilities", resources: [{ ...renamed, revision: "1" }] });
    store.getState().observe({ scope, source: "capabilities", resources: [{ ...renamed, revision: null }] });
    expect(selectActivityContext(store.getState()).entries.map((entry) => [entry.change, entry.resource.revision])).toEqual([
      ["updated", "1"],
      ["updated", "2"],
    ]);
  });

  test("duplicate resource IDs create one change per kind, without conflating skills and plugins", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    const skill: ActivityResource = { id: "shared", kind: "skill", label: "Summarize", revision: "1", href: "/skills" };
    const plugin: ActivityResource = { ...skill, kind: "plugin", label: "Team tools", href: "/plugins" };
    store.getState().observe({ scope, source: "capabilities", resources: [] });
    store.getState().observe({ scope, source: "capabilities", resources: [skill, skill, plugin, plugin] });
    store.getState().observe({ scope, source: "capabilities", resources: [plugin, skill] });

    expect(selectActivityContext(store.getState()).entries.map((entry) => [entry.resource.kind, entry.change])).toEqual([
      ["skill", "available"],
      ["plugin", "available"],
    ]);
    expect(selectActivityContext(store.getState()).snapshots.capabilities).toHaveLength(2);
  });

  test("an empty baseline allows a later addition once, using the observation time", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    const observedAt = Date.now() - 1_000;
    store.getState().observe({ scope, source: "providers", resources: [], observedAt: observedAt - 1_000 });
    expect(selectActivityContext(store.getState()).entries).toEqual([]);

    store.getState().observe({ scope, source: "providers", resources: [provider], observedAt });
    store.getState().observe({ scope, source: "providers", resources: [provider], observedAt: observedAt + 1 });
    expect(selectActivityContext(store.getState()).entries).toEqual([
      { id: expect.any(String), resource: provider, change: "available", observedAt },
    ]);
  });

  test("first successful inventory silently establishes the active member's baseline", () => {
    const store = createActivityStore(memoryStorage());
    expect(selectActivityContext(store.getState())).toBe(EMPTY_ACTIVITY_CONTEXT);

    store.getState().setScope(scope);
    const observedAt = Date.now() - 1_000;
    store.getState().observe({ scope, source: "providers", resources: [provider], observedAt });

    expect(store.getState().activeScopeKey).toBe(activityScopeKey(scope));
    expect(selectActivityContext(store.getState())).toEqual({
      entries: [],
      snapshots: { providers: [provider] },
      verifiedAt: observedAt,
      seenAt: null,
      baseline: { observedAt, labels: [provider.label] },
    });
  });

  test("the silent first inventory is summarized once across sources, counting plugin skills rather than their plugin", () => {
    const store = createActivityStore(memoryStorage());
    store.getState().setScope(scope);
    const observedAt = Date.now() - 1_000;
    const plugin: ActivityResource = { id: "plugin_one", kind: "plugin", label: "Team toolkit", revision: null, href: "/extensions", skillCount: 1 };
    const workflowPlugin: ActivityResource = { id: "plugin_two", kind: "plugin", label: "Workflows", revision: null, href: "/extensions", skillCount: 0 };
    const skill: ActivityResource = { id: "skill_one", kind: "skill", label: "Briefing", revision: "1", href: "/extensions", pluginName: "Team toolkit" };
    store.getState().observe({ scope, source: "providers", resources: [provider], observedAt });
    store.getState().observe({ scope, source: "capabilities", resources: [plugin, workflowPlugin, skill], observedAt: observedAt + 1 });
    store.getState().observe({ scope, source: "capabilities", resources: [plugin, skill], observedAt: observedAt + 2 });
    expect(selectActivityContext(store.getState()).baseline).toEqual({
      observedAt, labels: [provider.label, "Workflows", "Briefing"],
    });
    expect(selectActivityContext(store.getState()).entries.map((entry) => entry.change)).toEqual(["unavailable"]);
  });

  test("closing Activity marks the active member's history seen without touching entries, and survives reload", () => {
    const storage = memoryStorage();
    const store = createActivityStore(storage);
    store.getState().markSeen();
    expect(store.getState().contexts).toEqual({});
    store.getState().setScope(scope);
    store.getState().observe({ scope, source: "providers", resources: [] });
    store.getState().observe({ scope, source: "providers", resources: [provider] });
    const entries = selectActivityContext(store.getState()).entries;
    const seenAt = Date.now();
    store.getState().markSeen(seenAt);
    store.getState().markSeen(seenAt - 10);
    expect(selectActivityContext(store.getState()).seenAt).toBe(seenAt);
    expect(selectActivityContext(store.getState()).entries).toEqual(entries);
    const restored = createActivityStore(storage);
    restored.getState().setScope(scope);
    expect(selectActivityContext(restored.getState()).seenAt).toBe(seenAt);
    restored.getState().setScope({ ...scope, memberId: "member_other" });
    expect(selectActivityContext(restored.getState()).seenAt ?? null).toBeNull();
  });
});
