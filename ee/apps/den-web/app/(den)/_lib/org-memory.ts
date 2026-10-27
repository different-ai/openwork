import { type DenOrgContext, type DenOrgSummary } from "./den-org";

const LAST_ORGANIZATION_PREFIX = "openwork.den.lastOrganization:";

type OrganizationMemoryContext = {
  organization: Pick<DenOrgContext["organization"], "id">;
  currentMember: Pick<DenOrgContext["currentMember"], "userId">;
};

function memoryKey(userId: string): string | null {
  if (typeof window === "undefined" || !userId.trim()) return null;
  return `${LAST_ORGANIZATION_PREFIX}${JSON.stringify([window.location.origin, userId])}`;
}

/** A non-secret account preference, deliberately retained when credentials are cleared. */
export function rememberOrganization(userId: string, organizationId: string): void {
  const key = memoryKey(userId);
  const id = organizationId.trim();
  if (!key || !id) return;
  try {
    // Never persist names, membership details, tokens, or a guessed first organization.
    window.localStorage.setItem(key, id);
  } catch {
    // Storage restrictions must not prevent an acknowledged organization switch.
  }
}

/** Save an explicit choice immediately after its acknowledgement, not after loading details. */
export async function setActiveOrganizationAndRemember(input: {
  userId: string;
  organizationId: string;
  setActive: (organizationId: string) => Promise<void>;
  isCurrent: () => boolean;
}): Promise<boolean> {
  if (!input.isCurrent()) return false;
  await input.setActive(input.organizationId);
  if (!input.isCurrent()) return false;
  rememberOrganization(input.userId, input.organizationId);
  return true;
}

export function readRememberedOrganization(userId: string): string | null {
  const key = memoryKey(userId);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The directory must come from the current authenticated session. A stored ID
 * never leaves the browser until that directory confirms current membership.
 * Failed validation keeps the preference but falls back to the normal picker.
 */
export async function restoreRememberedOrganization(input: {
  userId: string;
  organizations: readonly DenOrgSummary[];
  loadContext: (organizationId: string) => Promise<OrganizationMemoryContext | null>;
  setActive: (organizationId: string) => Promise<void>;
  isCurrent: () => boolean;
}): Promise<DenOrgSummary | null> {
  if (!input.isCurrent()) return null;
  const rememberedId = readRememberedOrganization(input.userId);
  const organization = input.organizations.find((entry) => entry.id === rememberedId);
  if (!organization) return null;

  try {
    const context = await input.loadContext(organization.id);
    if (!input.isCurrent() || context?.organization.id !== organization.id
      || context.currentMember.userId !== input.userId) return null;

    // Publish nothing locally until the server acknowledges the new session choice.
    await input.setActive(organization.id);
    return input.isCurrent() ? organization : null;
  } catch {
    return null;
  }
}
