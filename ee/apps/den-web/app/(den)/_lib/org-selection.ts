import type { DenOrgSummary } from "./den-org";

/**
 * Cross-provider handshake for the post-sign-in organization picker.
 *
 * Sign-in (den-flow-provider) may request that the next dashboard load opens
 * the picker; the dashboard provider consumes that request when it loads the
 * org directory. Both sides of the sessionStorage handshake live here so the
 * key never leaks into provider code.
 *
 * The storage key string is a runtime contract with previously deployed
 * bundles in the same browser session — do not change it casually.
 */
const PENDING_SELECTION_KEY = "openwork:web:pending-org-selection";

export type OrgSelectionMode =
  /** More than one org and none is active yet: the member must pick. */
  | "required"
  /** More than one org with an active one: picking is optional. */
  | "available"
  /** Zero or one org: there is nothing to pick. */
  | "none";

export function getOrgSelectionMode(orgs: readonly DenOrgSummary[]): OrgSelectionMode {
  if (orgs.length < 2) {
    return "none";
  }
  return orgs.some((org) => org.isActive) ? "available" : "required";
}

/** Ask the next dashboard load to open the picker, if there is anything to pick. */
export function requestOrgSelectionOnNextLoad(orgs: readonly DenOrgSummary[]): void {
  if (typeof window === "undefined") {
    return;
  }
  if (getOrgSelectionMode(orgs) === "none") {
    return;
  }
  window.sessionStorage.setItem(PENDING_SELECTION_KEY, "1");
}

/** Read and clear a pending picker request. Returns whether one was pending. */
export function consumeOrgSelectionRequest(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const pending = window.sessionStorage.getItem(PENDING_SELECTION_KEY) === "1";
  window.sessionStorage.removeItem(PENDING_SELECTION_KEY);
  return pending;
}

/**
 * Whether the dashboard should render the picker for a freshly loaded org
 * directory: always when a pick is required, and on explicit request when a
 * pick is merely available. Consumes any pending request as a side effect.
 */
export function shouldOpenOrgSelection(orgs: readonly DenOrgSummary[]): boolean {
  const mode = getOrgSelectionMode(orgs);
  if (mode === "required") {
    return true;
  }
  const requested = consumeOrgSelectionRequest();
  return mode === "available" && requested;
}
