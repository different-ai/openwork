// Local observations of member access, not an audit log or a read/unread inbox.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";

import {
  activityScopeKey,
  type ActivityContext,
  type ActivityResource,
  type ActivityScope,
  type ActivitySource,
  type MemberActivityEntry,
} from "./activity-types";

export const PERSISTED_ACTIVITY_STORE_KEY = "openwork:member-activity:v1";

const SOURCES: ActivitySource[] = ["providers", "capabilities", "connections"];
const BASELINE_LABEL_LIMIT = 50;
const timestampSchema = z.number().int().nonnegative().refine((value) => value <= Date.now());
const resourceSchema = z.object({
  id: z.string().min(1).max(512),
  kind: z.enum(["provider", "skill", "plugin", "connection"]),
  label: z.string().min(1).max(512),
  revision: z.string().min(1).max(512).nullable(),
  href: z.string().max(2048).refine((href) =>
    href.startsWith("/") && !href.startsWith("//") && !/[\\\u0000-\u0020\u007f]/.test(href)),
  serviceId: z.string().min(1).max(256).optional(),
  pluginName: z.string().min(1).max(512).optional(),
  marketplaceName: z.string().min(1).max(512).optional(),
  skillCount: z.number().int().nonnegative().max(10_000).optional(),
  skillSlug: z.string().min(1).max(256).optional(),
  capability: z.string().min(1).max(1024).optional(),
});
const baselineSchema = z.object({
  observedAt: timestampSchema,
  labels: z.array(z.string().min(1).max(512)).max(BASELINE_LABEL_LIMIT),
});
const entrySchema = z.object({
  id: z.string().min(1).max(512),
  resource: resourceSchema,
  change: z.enum(["available", "updated", "unavailable"]),
  observedAt: timestampSchema,
});
const contextSchema = z.object({
  entries: z.array(z.unknown()).catch([]),
  snapshots: z.object({
    providers: z.unknown().optional(),
    capabilities: z.unknown().optional(),
    connections: z.unknown().optional(),
  }).catch({}),
  verifiedAt: z.unknown(),
  seenAt: z.unknown().optional(),
  baseline: z.unknown().optional(),
});
const persistedSchema = z.object({ contexts: z.record(z.string(), z.unknown()) });
const scopeKeySchema = z.tuple([z.string().url(), z.string().min(1), z.string().min(1)]);

export type ActivityStoreState = {
  activeScopeKey: string | null;
  contexts: Record<string, ActivityContext>;
  refreshState: "idle" | "refreshing" | "error";
  setScope: (scope: ActivityScope | null) => void;
  /** Feed only successful, complete inventories; failed syncs must not become empty snapshots. */
  observe: (input: {
    scope: ActivityScope;
    source: ActivitySource;
    resources: ActivityResource[];
    observedAt?: number;
  }) => void;
  setRefreshState: (scope: ActivityScope, state: ActivityStoreState["refreshState"]) => void;
  /** Closing the Activity popover marks everything observed so far as seen for the active member. */
  markSeen: (seenAt?: number) => void;
};

export const EMPTY_ACTIVITY_CONTEXT: ActivityContext = {
  entries: [],
  snapshots: {},
  verifiedAt: null,
  seenAt: null,
  baseline: null,
};

/** A plugin that carries skills is represented by those skills, not counted twice. */
function baselineLabels(resources: ActivityResource[]) {
  return resources
    .filter((resource) => resource.kind !== "plugin" || !resource.skillCount)
    .map((resource) => resource.label);
}

export function selectActivityContext(state: ActivityStoreState): ActivityContext {
  return (state.activeScopeKey ? state.contexts[state.activeScopeKey] : undefined)
    ?? EMPTY_ACTIVITY_CONTEXT;
}

function validScopeKey(key: string): boolean {
  try {
    const parsed = scopeKeySchema.safeParse(JSON.parse(key));
    if (!parsed.success) return false;
    const [baseUrl, organizationId, memberId] = parsed.data;
    const url = new URL(baseUrl);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username && !url.password && !url.search && !url.hash
      && activityScopeKey({ baseUrl, organizationId, memberId }) === key;
  } catch {
    return false;
  }
}

function sanitizeContexts(value: unknown): Record<string, ActivityContext> {
  const parsed = persistedSchema.safeParse(value);
  if (!parsed.success) return {};
  const contexts: Record<string, ActivityContext> = {};
  for (const [key, value] of Object.entries(parsed.data.contexts)) {
    if (!validScopeKey(key)) continue;
    const context = contextSchema.safeParse(value);
    if (!context.success) continue;
    const entries = context.data.entries.flatMap((value) => {
      const entry = entrySchema.safeParse(value);
      return entry.success ? [entry.data] : [];
    });
    const snapshots: ActivityContext["snapshots"] = {};
    for (const source of SOURCES) {
      const inventory = z.array(resourceSchema).safeParse(context.data.snapshots[source]);
      // A partly corrupt inventory is not a complete baseline; silently reseed it.
      if (inventory.success) {
        snapshots[source] = [...new Map(inventory.data.map((resource) => [JSON.stringify([resource.kind, resource.id]), resource])).values()];
      }
    }
    const verifiedAt = timestampSchema.safeParse(context.data.verifiedAt);
    const seenAt = timestampSchema.safeParse(context.data.seenAt);
    const baseline = baselineSchema.safeParse(context.data.baseline);
    contexts[key] = {
      entries,
      snapshots,
      verifiedAt: verifiedAt.success ? verifiedAt.data : null,
      seenAt: seenAt.success ? seenAt.data : null,
      baseline: baseline.success ? baseline.data : null,
    };
  }
  return contexts;
}

function pruneContexts(
  contexts: Record<string, ActivityContext>,
  recentKey?: string | null,
): Record<string, ActivityContext> {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  // JSON object order preserves recency without persisting active identity or UI status.
  const recent = Object.entries(contexts)
    .sort(([left], [right]) => left === recentKey ? -1 : right === recentKey ? 1 : 0)
    .slice(0, 5);
  return Object.fromEntries(recent.map(([key, context]) => [key, {
    ...context,
    entries: context.entries
      .filter((entry) => entry.observedAt >= cutoff)
      .sort((left, right) => right.observedAt - left.observedAt)
      .slice(0, 100),
  }]));
}

/** Uses browser localStorage by default; injected storage keeps tests and alternate hosts isolated. */
export function createActivityStore(storage?: StateStorage) {
  // Defer observations and writes until their persisted baselines are available.
  let hydrated = false;
  const pending: Parameters<ActivityStoreState["observe"]>[0][] = [];
  const jsonStorage = createJSONStorage<{ contexts: Record<string, ActivityContext> }>(() => {
    const target = storage ?? localStorage;
    return {
      getItem: (name) => target.getItem(name),
      setItem: (name, value) => {
        if (!hydrated) return;
        try {
          const result = target.setItem(name, value);
          if (result instanceof Promise) return result.catch(() => {});
          return result;
        } catch {
          // Device storage can be disabled or full; the in-memory feed still works.
        }
      },
      removeItem: (name) => target.removeItem(name),
    };
  });
  const safeStorage = jsonStorage ? {
    ...jsonStorage,
    getItem: (name: string) => {
      try {
        const result = jsonStorage.getItem(name);
        // Do not interpret missing, malformed or future persistence formats.
        if (result instanceof Promise) return result.then((value) => value?.version === 1 ? value : null).catch(() => null);
        return result?.version === 1 ? result : null;
      } catch {
        return null;
      }
    },
  } : undefined;
  if (!safeStorage) hydrated = true;
  return create<ActivityStoreState>()(persist((set) => ({
    activeScopeKey: null,
    contexts: {},
    refreshState: "idle",
    setScope: (scope) => set((state) => {
      const key = scope ? activityScopeKey(scope) : null;
      const activeScopeKey = key && validScopeKey(key) ? key : null;
      if (activeScopeKey !== state.activeScopeKey) pending.length = 0;
      return { activeScopeKey, contexts: pruneContexts(state.contexts, activeScopeKey), refreshState: "idle" };
    }),
    observe: ({ scope, source, resources, observedAt = Date.now() }) => set((state) => {
      const key = activityScopeKey(scope);
      if (key !== state.activeScopeKey) return state;
      const parsed = z.array(resourceSchema).safeParse(resources);
      if (!parsed.success || !timestampSchema.safeParse(observedAt).success) return state;
      if (!hydrated) {
        pending.push({ scope: { ...scope }, source, resources: parsed.data, observedAt });
        return state;
      }
      const context = state.contexts[key] ?? EMPTY_ACTIVITY_CONTEXT;
      const previous = context.snapshots[source];
      const inventory = [...new Map(parsed.data.map((resource) => [JSON.stringify([resource.kind, resource.id]), resource])).values()];
      const changes: MemberActivityEntry[] = [];
      if (previous !== undefined) {
        for (const resource of inventory) {
          const before = previous.find((entry) => entry.kind === resource.kind && entry.id === resource.id);
          if (!before) {
            changes.push({ id: crypto.randomUUID(), resource, change: "available", observedAt });
          } else if (
            resource.kind !== "provider"
            // Learning or losing a revision is not evidence that content changed.
            && before.revision !== null
            && resource.revision !== null
            && before.revision !== resource.revision
          ) {
            changes.push({ id: crypto.randomUUID(), resource, change: "updated", observedAt });
          }
        }
        for (const resource of previous) {
          if (!inventory.some((entry) => entry.kind === resource.kind && entry.id === resource.id)) {
            changes.push({ id: crypto.randomUUID(), resource, change: "unavailable", observedAt });
          }
        }
      }
      // The first complete inventory stays silent, but is kept as one summary
      // ("4 things were already shared with you") instead of disappearing.
      const baseline = previous === undefined
        ? {
          observedAt: context.baseline?.observedAt ?? observedAt,
          labels: [...(context.baseline?.labels ?? []), ...baselineLabels(inventory)].slice(0, BASELINE_LABEL_LIMIT),
        }
        : context.baseline ?? null;
      return {
        contexts: pruneContexts({
          ...state.contexts,
          [key]: {
            ...context,
            baseline,
            entries: [...changes, ...context.entries],
            snapshots: { ...context.snapshots, [source]: inventory },
            verifiedAt: observedAt,
          },
        }, key),
      };
    }),
    setRefreshState: (scope, refreshState) => set((state) =>
      activityScopeKey(scope) === state.activeScopeKey
        ? { refreshState, contexts: pruneContexts(state.contexts) }
        : state),
    markSeen: (seenAt = Date.now()) => set((state) => {
      const key = state.activeScopeKey;
      const context = key ? state.contexts[key] : undefined;
      if (!key || !context || !hydrated || !timestampSchema.safeParse(seenAt).success) return state;
      if ((context.seenAt ?? 0) >= seenAt) return state;
      return { contexts: { ...state.contexts, [key]: { ...context, seenAt } } };
    }),
  }), {
    name: PERSISTED_ACTIVITY_STORE_KEY,
    version: 1,
    storage: safeStorage,
    onRehydrateStorage: () => (state) => {
      hydrated = true;
      for (const input of pending.splice(0)) state?.observe(input);
    },
    partialize: (state) => ({ contexts: state.contexts }),
    merge: (persistedState, currentState) => {
      return {
        ...currentState,
        contexts: pruneContexts(sanitizeContexts(persistedState), currentState.activeScopeKey),
      };
    },
  }));
}

export const useActivityStore = createActivityStore();
