export const ORG_SCOPE_HEADER = "x-openwork-org-id";

let currentOrgScope: string | null = null;

export class OrganizationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationNotFoundError";
  }
}

export function setRequestOrgScope(orgId: string | null) {
  currentOrgScope = orgId;
}

export function getRequestOrgScope(): string | null {
  return currentOrgScope;
}

export function shouldPinOrgScopePath(path: string): boolean {
  const markerIndex = path.search(/[?#]/);
  const pathOnly = markerIndex === -1 ? path : path.slice(0, markerIndex);

  if (!pathOnly.startsWith("/v1/")) {
    return false;
  }

  const normalizedPath = pathOnly.replace(/\/+$/, "");
  return normalizedPath !== "/v1/me" && normalizedPath !== "/v1/me/orgs";
}
