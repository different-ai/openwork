import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { providerShareInvite } from "./provider-share-invite.ts";

/** The provider sharing world with exact provider search and guided sharing turned on for the organization. */
export async function providerShareGuided(seed: Seed) {
  const world = await providerShareInvite(seed);
  await enableOrganizationCapabilities(seed, world.den.admin, { providerFilterSyncFix: true }, world.organizationId);
  return world;
}
