import type { createDenClient, DenOrgSummary } from "./den";

const LAST_ORGANIZATION_PREFIX = "openwork.den.lastOrganization:";

type OrganizationMemoryScope = {
  serverKey: string | null;
  userId: string;
};

function memoryKey(scope: OrganizationMemoryScope): string | null {
  const serverKey = scope.serverKey?.trim() ?? "";
  const userId = scope.userId.trim();
  return serverKey && userId
    ? `${LAST_ORGANIZATION_PREFIX}${JSON.stringify([serverKey, userId])}`
    : null;
}

export function rememberDenOrganization(scope: OrganizationMemoryScope, organizationId: string): void {
  const key = memoryKey(scope);
  const id = organizationId.trim();
  if (!key || !id || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, id);
  } catch {
  }
}

export function readRememberedDenOrganization(scope: OrganizationMemoryScope): string | null {
  const key = memoryKey(scope);
  if (!key || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

type OrganizationMemoryClient = Pick<
  ReturnType<typeof createDenClient>,
  "listOrgs" | "setActiveOrganization"
>;

export async function restoreRememberedDenOrganization(input: OrganizationMemoryScope & {
  client: OrganizationMemoryClient;
  isCurrent: () => boolean;
}): Promise<DenOrgSummary | null> {
  const rememberedId = readRememberedDenOrganization(input);
  if (!rememberedId || !input.isCurrent()) return null;

  try {
    const directory = await input.client.listOrgs();
    const organization = directory.orgs.find((org) => org.id === rememberedId);
    if (!organization || !input.isCurrent()) return null;

    await input.client.setActiveOrganization({ organizationId: organization.id });
    return input.isCurrent() ? organization : null;
  } catch {
    return null;
  }
}
