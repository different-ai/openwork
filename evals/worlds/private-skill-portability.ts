import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function privateSkillPortabilityWorld(seed: Seed) {
  const owner = { name: "Test Owner", email: "private-skills-owner@example.test", password: "OpenWorkEval123!" };
  const den = await seed.den({ web: true, org: { name: "Example Workspace", admin: owner } });
  return {
    owner: await seed.web({ den, signedInAs: owner, startPath: "/dashboard/config?tab=export", headless: true, viewport: { width: 1440, height: 900 } }),
    enablePortability: () => enableOrganizationCapabilities(seed, den.admin, { personalSkillPortability: true }),
  };
}
