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

export function rememberOrganization(userId: string, organizationId: string): void {
  const key = memoryKey(userId);
  const id = organizationId.trim();
  if (!key || !id) return;
  try {
    window.localStorage.setItem(key, id);
  } catch {
  }
}

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

    await input.setActive(organization.id);
    return input.isCurrent() ? organization : null;
  } catch {
    return null;
  }
}
