import type { createDenClient, DenOrgSummary } from "./den";

const LAST_ORGANIZATION_PREFIX = "openwork.den.lastOrganization:";

type OrganizationMemoryScope = {
  /** Canonical control-plane key from denOriginComparisonKey. */
  serverKey: string | null;
  /** An identity verified by this control plane, never an email or a draft. */
  userId: string;
};

function memoryKey(scope: OrganizationMemoryScope): string | null {
  const serverKey = scope.serverKey?.trim() ?? "";
  const userId = scope.userId.trim();
  return serverKey && userId
    ? `${LAST_ORGANIZATION_PREFIX}${JSON.stringify([serverKey, userId])}`
    : null;
}

/** A non-secret preference, separate from credentials so sign-out does not erase it. */
export function rememberDenOrganization(scope: OrganizationMemoryScope, organizationId: string): void {
  const key = memoryKey(scope);
  const id = organizationId.trim();
  if (!key || !id || typeof window === "undefined") return;
  try {
    // Store only the ID, not member data, organization names, or credentials.
    window.localStorage.setItem(key, id);
  } catch {
    // Remembering a preference must never block sign-in or switching organizations.
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

/**
 * Resolve a returning account's preference using its newly issued credential.
 * Current membership must allow it. Failure falls back to
 * the normal chooser without losing the preference or retrying the handoff.
 */
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

    // Align the new server session before publishing the remembered org locally.
    await input.client.setActiveOrganization({ organizationId: organization.id });
    return input.isCurrent() ? organization : null;
  } catch {
    return null;
  }
}
