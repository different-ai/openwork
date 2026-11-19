import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";

/** The admin's active (seeded) organization id, or "" when Den reports none. */
export async function seededOrganizationId(seed: Seed, admin: Parameters<Seed["api"]>[0]): Promise<string> {
  const context = await seed.api(admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  return organization && typeof organization.id === "string" ? organization.id : "";
}

/**
 * Org capabilities (feature flags) are default-off per
 * organization. Worlds switch the ones they need on through
 * the platform-admin route the /admin panel uses; the seeded org admin is the
 * platform admin.
 */
export async function enableOrganizationCapabilities(
  seed: Seed,
  admin: Parameters<Seed["api"]>[0],
  capabilities: Record<string, true>,
  organizationId?: string,
): Promise<string> {
  const orgId = organizationId || await seededOrganizationId(seed, admin);
  const names = Object.keys(capabilities).join(", ");
  if (!orgId) throw new Error(`Could not resolve the seeded organization to enable ${names}.`);
  const result = await seed.api(admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    body: JSON.stringify({ capabilities }),
  });
  if (!result.response.ok) {
    throw new Error(`Enabling ${names} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return orgId;
}
