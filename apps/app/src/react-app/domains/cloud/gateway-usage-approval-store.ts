import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GatewayUsageBucket } from "@openwork/types/den/gateway-usage-limits";

export const GATEWAY_APPROVAL_DISMISSALS_KEY = "openwork:gateway-approval-dismissals:v1";

// An increase can be approved once per bucket window. Do not key by session,
// token, usage total, or query generation: those change without a new approval.
export function gatewayApprovalKey(scopeKey: string, bucket: GatewayUsageBucket): string {
  return JSON.stringify([scopeKey, bucket.id, bucket.resetAt]);
}

type ApprovalDismissals = {
  dismissedKeys: string[];
  dismiss: (keys: string[]) => void;
};

export const useGatewayApprovalDismissals = create<ApprovalDismissals>()(persist(
  (set) => ({
    dismissedKeys: [],
    dismiss: (keys) => set((state) => ({ dismissedKeys: [...new Set([...state.dismissedKeys, ...keys])] })),
  }),
  {
    name: GATEWAY_APPROVAL_DISMISSALS_KEY,
    storage: createJSONStorage(() => ({
      getItem: (key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      },
      setItem: (key, value) => {
        // Dismiss in memory even if storage is unavailable or full.
        try { localStorage.setItem(key, value); } catch { /* Best-effort persistence. */ }
      },
      removeItem: (key) => {
        try { localStorage.removeItem(key); } catch { /* Best-effort persistence. */ }
      },
    })),
    partialize: (state) => ({ dismissedKeys: state.dismissedKeys }),
    merge: (persisted, current) => {
      if (typeof persisted !== "object" || persisted === null || !("dismissedKeys" in persisted)
        || !Array.isArray(persisted.dismissedKeys)
        || !persisted.dismissedKeys.every((key): key is string => typeof key === "string")) return current;
      return { ...current, dismissedKeys: persisted.dismissedKeys };
    },
  },
));
