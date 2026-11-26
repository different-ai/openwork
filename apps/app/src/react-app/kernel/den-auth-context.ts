import { createContext, use } from "react";
import type { DenUser } from "@/app/lib/den-types";

export type DenAuthStatus = "checking" | "signed_in" | "unavailable" | "signed_out";

export type VerifiedDenIdentity = { principalId: string; organizationId: string };

export type DenAuthStore = {
  status: DenAuthStatus;
  user: DenUser | null;
  verifiedIdentity: VerifiedDenIdentity | null;
  error: string | null;
  isSignedIn: boolean;
  refresh: () => Promise<void>;
};

export const DenAuthContext = createContext<DenAuthStore | undefined>(undefined);

let currentVerifiedIdentity: VerifiedDenIdentity | null = null;
const verifiedIdentityListeners = new Set<() => void>();

export function getVerifiedDenIdentity(): VerifiedDenIdentity | null {
  return currentVerifiedIdentity;
}

export function publishVerifiedDenIdentity(identity: VerifiedDenIdentity | null) {
  if (
    currentVerifiedIdentity?.principalId === identity?.principalId
    && currentVerifiedIdentity?.organizationId === identity?.organizationId
  ) {
    return;
  }
  currentVerifiedIdentity = identity;
  for (const listener of verifiedIdentityListeners) listener();
}

export function subscribeVerifiedDenIdentity(listener: () => void): () => void {
  verifiedIdentityListeners.add(listener);
  return () => { verifiedIdentityListeners.delete(listener); };
}

export function useDenAuth(): DenAuthStore {
  const context = use(DenAuthContext);
  if (!context) throw new Error("useDenAuth must be used within a DenAuthProvider");
  return context;
}
