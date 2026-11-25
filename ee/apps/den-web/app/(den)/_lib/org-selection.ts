import type { DenOrgSummary } from "./den-org";

const PENDING_SELECTION_KEY = "openwork:web:pending-org-selection";

export type OrgSelectionMode =
  | "required"
  | "available"
  | "none";

export function getOrgSelectionMode(orgs: readonly DenOrgSummary[]): OrgSelectionMode {
  if (orgs.length < 2) {
    return "none";
  }
  return orgs.some((org) => org.isActive) ? "available" : "required";
}

export function requestOrgSelectionOnNextLoad(orgs: readonly DenOrgSummary[]): void {
  if (typeof window === "undefined") {
    return;
  }
  if (getOrgSelectionMode(orgs) === "none") {
    return;
  }
  window.sessionStorage.setItem(PENDING_SELECTION_KEY, "1");
}

export function consumeOrgSelectionRequest(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const pending = window.sessionStorage.getItem(PENDING_SELECTION_KEY) === "1";
  window.sessionStorage.removeItem(PENDING_SELECTION_KEY);
  return pending;
}

export function shouldOpenOrgSelection(
  orgs: readonly DenOrgSummary[],
  requested = consumeOrgSelectionRequest(),
): boolean {
  const mode = getOrgSelectionMode(orgs);
  return mode === "required" || (mode === "available" && requested);
}
