import type { Seed } from "@openwork/env";
import { managedDeploymentConfigurationSchema, managedDeploymentLaunchSchema, managedDeploymentSchema } from "@openwork/types/den/managed-deployments";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const PORTAL_URL = "https://acme.awsapps.com/start";
export const PORTAL_HOST = "acme.awsapps.com";
export const ROLE_NAME = "AdministratorAccess";
export const ACCOUNT_ID = "123456789012";
export const DEPLOYMENT_NAME = "OpenWork production";

/**
 * Manage › Deployments on a real cloud Den with an AWS release configured. The
 * organization has one AWS deployment whose install is prepared and waiting
 * for approval in AWS. Nothing reaches AWS: the proof reads the links Den
 * issues and never opens them. The admin is signed in on Den Web.
 */
export async function deploymentsAwsSignInWorld(seed: Seed) {
  const den = await seed.den({
    env: {
      DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.0.2",
      DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/template.json",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/bundle.tar.gz",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
    },
    org: { name: "Acme workspace", admin: { name: "Deployment Admin" }, members: {} },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true });
  const created = await seed.api(den.admin, "/v1/managed-deployments", {
    method: "POST",
    body: JSON.stringify({
      provider: "aws", name: DEPLOYMENT_NAME, domainName: "openwork.example.test", ownerEmail: "admin@example.test",
      target: { accountId: ACCOUNT_ID, region: "us-east-1", route53ZoneId: "ZTEST", runtimeProfile: "legacy" },
    }),
  });
  if (!created.response.ok) throw new Error(`Creating the deployment failed: HTTP ${created.response.status} ${created.text.slice(0, 400)}`);
  const deployment = managedDeploymentSchema.parse(created.body);
  const launchPath = `/v1/managed-deployments/${deployment.id}/launch`;
  const prepared = await seed.api(den.admin, launchPath, { method: "POST", body: JSON.stringify({ kind: "install" }) });
  if (!prepared.response.ok) throw new Error(`Preparing the install failed: HTTP ${prepared.response.status} ${prepared.text.slice(0, 400)}`);

  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/deployments", headless: true, viewport: { width: 1440, height: 1200 } });
  return {
    den,
    web,
    deploymentId: deployment.id,
    async turnOnGuidedDeployments() {
      await enableOrganizationCapabilities(seed, den.admin, { managedDeploymentAwsSignIn: true }, organizationId);
    },
    /** The sign-in Den has saved for the organization. */
    async savedSignIn() {
      const result = await seed.api(den.admin, "/v1/managed-deployments/configuration");
      return managedDeploymentConfigurationSchema.parse(result.body).awsSignIn;
    },
    /** The approval link Den issues for the prepared install, read without opening it. */
    async approvalUrl() {
      const result = await seed.api(den.admin, launchPath, { method: "POST", body: JSON.stringify({ kind: "install" }) });
      return managedDeploymentLaunchSchema.parse(result.body).approvalUrl ?? "";
    },
  };
}
export const supportedTargets = ["local/host"];
