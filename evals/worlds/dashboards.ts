import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";

/**
 * Org capabilities such as org-managed Dashboards are default-off per
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
  let orgId = organizationId ?? "";
  if (!orgId) {
    const context = await seed.api(admin, "/v1/org");
    const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
    orgId = organization && typeof organization.id === "string" ? organization.id : "";
  }
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

export function enableOrgManagedDashboards(seed: Seed, admin: Parameters<Seed["api"]>[0], organizationId?: string): Promise<string> {
  return enableOrganizationCapabilities(seed, admin, { orgManagedDashboards: true }, organizationId);
}
