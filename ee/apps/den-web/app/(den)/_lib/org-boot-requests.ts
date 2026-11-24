import { type DenOrgContext, parseOrgContextPayload } from "./den-org";

export function shouldStartOrgBootRequests(href: string, requestOrgScope: string | null): boolean {
  if (requestOrgScope) return false;
  try {
    return !new URL(href).searchParams.has("workbotOrganizationId");
  } catch {
    return false;
  }
}

export function bootOrgContextFor(
  early: { response: { ok: boolean }; payload: unknown } | null,
  organizationId: string,
): DenOrgContext | null {
  if (!early?.response.ok) return null;
  const parsed = parseOrgContextPayload(early.payload);
  return parsed && parsed.organization.id === organizationId ? parsed : null;
}
