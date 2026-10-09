import { createOrg, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";

/**
 * Real Den on the cloud deployment with a published (fixture) AWS installer
 * release, one workspace with deployments turned on, one with them off, and a
 * member. No AWS account is touched: the release URLs are never fetched by Den.
 */
export async function managedDeployments(seed: Seed) {
  const stamp = Date.now();
  const names = { enabled: `Deployments workspace ${stamp}`, disabled: `Deployments off ${stamp}` };
  const den = await seed.den({
    env: {
      DEN_DEPLOYMENT: "cloud", DEN_ORG_MODE: "multi_org",
      DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/aws/0.18.57/cloudformation.json",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/aws/0.18.57/bundle.tar.gz",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
      DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "0.18.57",
    },
    org: { name: names.enabled, admin: { name: "Deployment Owner" }, members: { member: { name: "Deployment Member" } } },
  });
  const enabledOrgId = await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true });
  const disabledOrg = await createOrg(den, names.disabled);
  const viewport = { width: 1440, height: 1000 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/deployments", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport });
  return {
    den, web, memberWeb, names, enabledOrgId, disabledOrgId: disabledOrg.id, baseUrl: den.ref.webUrl,
    async [Symbol.asyncDispose]() { await disabledOrg[Symbol.asyncDispose](); },
  };
}
