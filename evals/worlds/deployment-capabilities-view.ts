import type { Seed } from "@openwork/env";
import { managedDeploymentSchema } from "@openwork/types/den/managed-deployments";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const DEPLOYMENT_NAME = "OpenWork production";

/**
 * Settings › Capabilities on a real cloud Den that has the headless runner and
 * Workbot configured, so Den reports Workbot as installed for every
 * organization. The organization's own Workbot switch is off: installed, yet
 * no member may use it. One AWS deployment exists for the deployment page's
 * list. The addresses name services that are not running; nothing calls them.
 */
export async function deploymentCapabilitiesViewWorld(seed: Seed) {
  const den = await seed.den({
    env: {
      DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.0.2",
      DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/template.json",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/bundle.tar.gz",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
      DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:8795",
      DEN_HEADLESS_RUNNER_TOKEN: "capability-proof-runner-token-0123456789abcdef",
      DEN_WORKBOT_URL: "https://chat.example.test",
    },
    org: { name: "Acme workspace", admin: { name: "Workspace Admin" }, members: {} },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true, managedDeploymentAwsSignIn: true });

  async function setWorkbotForEveryone(enabled: boolean) {
    const saved = await seed.api(den.admin, "/v1/org/workbot-settings/everyone", { method: "PUT", body: JSON.stringify({ enabled }) });
    if (!saved.response.ok) throw new Error(`Turning Workbot ${enabled ? "on" : "off"} for everyone failed: HTTP ${saved.response.status} ${saved.text.slice(0, 400)}`);
  }
  await setWorkbotForEveryone(false);

  const created = await seed.api(den.admin, "/v1/managed-deployments", {
    method: "POST",
    body: JSON.stringify({
      provider: "aws", name: DEPLOYMENT_NAME, domainName: "openwork.example.test", ownerEmail: "admin@example.test",
      target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", runtimeProfile: "legacy" },
    }),
  });
  if (!created.response.ok) throw new Error(`Creating the deployment failed: HTTP ${created.response.status} ${created.text.slice(0, 400)}`);
  const deployment = managedDeploymentSchema.parse(created.body);

  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/capabilities", headless: true, viewport: { width: 1440, height: 1000 } });
  return {
    den,
    web,
    capabilitiesUrl: new URL("/dashboard/capabilities", den.ref.webUrl).href,
    deploymentUrl: new URL(`/dashboard/deployments/${deployment.id}`, den.ref.webUrl).href,
    async turnOnCapabilitiesView() {
      await enableOrganizationCapabilities(seed, den.admin, { deploymentCapabilitiesView: true }, organizationId);
    },
    setWorkbotForEveryone,
  };
}
export const supportedTargets = ["local/host"];
