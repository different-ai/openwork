import { createOrg, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";

export async function awsManagedDeployments(seed: Seed) {
  const stamp = Date.now();
  const names = { enabled: `AWS deployment workspace ${stamp}`, disabled: `AWS rollout off ${stamp}` };
  const den = await seed.den({
    env: {
      DEN_DEPLOYMENT: "cloud", DEN_ORG_MODE: "multi_org",
      DEN_API_PUBLIC_URL: "https://api.example.test",
      DEN_AWS_DEPLOYMENT_TEMPLATE_URL: "https://releases.example.test/cloudformation.json",
      DEN_AWS_DEPLOYMENT_BUNDLE_URL: "https://releases.example.test/bundle.tar.gz",
      DEN_AWS_DEPLOYMENT_BUNDLE_SHA256: "a".repeat(64), DEN_AWS_DEPLOYMENT_VERSION: "0.18.57",
    },
    org: { name: names.enabled, admin: { name: "Deployment Owner" }, members: { member: { name: "Deployment Member" } } },
  });
  const enabledOrgId = await enableOrganizationCapabilities(seed, den.admin, { awsManagedDeployments: true });
  const disabledOrg = await createOrg(den, names.disabled);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/aws-deployments", headless: true, viewport: { width: 1440, height: 1000 } });
  const memberWeb = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, memberWeb, names, enabledOrgId, disabledOrgId: disabledOrg.id, baseUrl: den.ref.webUrl,
    async [Symbol.asyncDispose]() { await disabledOrg[Symbol.asyncDispose](); },
  };
}
