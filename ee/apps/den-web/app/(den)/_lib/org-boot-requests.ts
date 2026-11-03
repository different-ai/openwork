import { type DenOrgContext, parseOrgContextPayload } from "./den-org";

/**
 * A dashboard page load may start the workspace list and the session's active
 * workspace details before the sign-in check returns. Skip that when this load
 * is already pinned to a workspace (an in-app load, or a Workbot recovery link
 * that opens a specific team), because the unscoped answer would be discarded.
 */
export function shouldStartOrgBootRequests(href: string, requestOrgScope: string | null): boolean {
  if (requestOrgScope) return false;
  try {
    return !new URL(href).searchParams.has("workbotOrganizationId");
  } catch {
    return false;
  }
}

/**
 * The unscoped boot `/v1/org` answers for whichever workspace the session had
 * active. Reuse it only when that is exactly the workspace being opened, so
 * a switch, a remembered workspace or setup still loads its own details.
 */
export function bootOrgContextFor(
  early: { response: { ok: boolean }; payload: unknown } | null,
  organizationId: string,
): DenOrgContext | null {
  if (!early?.response.ok) return null;
  const parsed = parseOrgContextPayload(early.payload);
  return parsed && parsed.organization.id === organizationId ? parsed : null;
}
