import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";

export type ProviderCredentialHealth = "unverified" | "verified" | "rejected";

const entrySchema = z.object({
  status: z.enum(["verified", "rejected"]),
  revision: z.number(),
  observedAt: z.number().default(0),
});
const persistedSchema = z.object({
  entries: z.record(z.string(), entrySchema),
  revisions: z.record(z.string(), z.number()),
  configurations: z.record(z.string(), z.string()).default({}),
  workspaceScopes: z.record(z.string(), z.string()).default({}),
});

/** Evidence belongs to the workspace's runtime provider, never its display name. */
export function credentialHealthKey(workspaceId: string, providerId: string): string {
  return JSON.stringify([workspaceId, providerId]);
}

/** Local workspaces share one device auth store; remote hosts do not. */
export function providerCredentialScope(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "device";
    return url.origin + url.pathname.split(/\/workspace\//)[0].replace(/\/opencode2?\/?$/, "");
  } catch { return "unresolved"; }
}

type CredentialHealthState = {
  entries: Record<string, z.infer<typeof entrySchema>>;
  revisions: Record<string, number>;
  configurations: Record<string, string>;
  workspaceScopes: Record<string, string>;
  bindWorkspace: (workspaceId: string, scope: string) => void;
  configure: (workspaceId: string, providerId: string, version: string) => void;
  changed: (workspaceId: string, providerId: string) => void;
  observe: (workspaceId: string, providerId: string, status: "verified" | "rejected", startedAt: number, observedAt?: number) => void;
};

/** Only the outcome is retained. No keys, error text, response bodies or model output. */
export const useProviderCredentialHealth = create<CredentialHealthState>()(persist((set) => ({
  entries: {},
  revisions: {},
  configurations: {},
  workspaceScopes: {},
  bindWorkspace: (workspaceId, scope) => set((state) => {
    const previous = state.workspaceScopes[workspaceId];
    if (previous === scope) return state;
    const entries = { ...state.entries };
    const revisions = { ...state.revisions };
    if (previous !== undefined) {
      const prefix = JSON.stringify([workspaceId]).slice(0, -1) + ",";
      for (const key of Object.keys(entries)) if (key.startsWith(prefix)) {
        delete entries[key];
        revisions[key] = Date.now();
      }
    }
    return { entries, revisions, workspaceScopes: { ...state.workspaceScopes, [workspaceId]: scope } };
  }),
  configure: (workspaceId, providerId, version) => {
    const key = credentialHealthKey(workspaceId, providerId);
    const previous = useProviderCredentialHealth.getState().configurations[key];
    if (previous !== undefined && previous !== version) useProviderCredentialHealth.getState().changed(workspaceId, providerId);
    set((state) => ({ configurations: { ...state.configurations, [key]: version } }));
  },
  changed: (workspaceId, providerId) => set((state) => {
    const entries = { ...state.entries };
    const revisions = { ...state.revisions };
    const scope = state.workspaceScopes[workspaceId];
    const workspaces = scope === undefined ? [workspaceId] : [workspaceId, ...Object.keys(state.workspaceScopes).filter((id) => state.workspaceScopes[id] === scope)];
    for (const id of workspaces) {
      const key = credentialHealthKey(id, providerId);
      delete entries[key];
      revisions[key] = Date.now();
    }
    return { entries, revisions };
  }),
  observe: (workspaceId, providerId, status, startedAt, observedAt = Date.now()) => set((state) => {
    const key = credentialHealthKey(workspaceId, providerId);
    const revision = state.revisions[key] ?? 0;
    // A request already in flight when a key was replaced cannot bless or
    // reject the replacement. Equal timestamps are conservatively ignored.
    if (revision >= startedAt) return state;
    const current = state.entries[key];
    if (current && (current.observedAt > observedAt || (current.observedAt === observedAt && current.status === status))) return state;
    return { entries: { ...state.entries, [key]: { status, revision, observedAt } } };
  }),
}), {
  name: "openwork.provider-credential-health.v1",
  storage: createJSONStorage(() => ({
    getItem: (key) => {
      try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
    },
    setItem: (key, value) => {
      try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); } catch { /* Health must never interrupt chat when storage is full or blocked. */ }
    },
    removeItem: (key) => {
      try { if (typeof localStorage !== "undefined") localStorage.removeItem(key); } catch { /* Keep in-memory evidence when persistence is unavailable. */ }
    },
  })),
  partialize: ({ entries, revisions, configurations, workspaceScopes }) => ({ entries, revisions, configurations, workspaceScopes }),
  merge: (persisted, current) => {
    const parsed = persistedSchema.safeParse(persisted);
    return parsed.success ? { ...current, ...parsed.data } : current;
  },
}));
