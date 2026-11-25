import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";

/** Values the Den in this world is started with. None may reach a browser. */
export const WORLD_SECRETS = {
  DEN_MAINTENANCE_TOKEN: "config-export-proof-maintenance-token-0123456789",
  DEN_GATEWAY_KEY: "config-export-proof-gateway-key-0123456789abcdef",
};

/**
 * A real self-hosted Den whose Helm chart was written for 0.19.1 while the
 * server image is 0.19.2, with one feature locked off by the deployment. The
 * seeded admin is the installation administrator; the member is not.
 */
export async function diagnosticsConfigExportWorld(seed: Seed) {
  const den = await seed.den({
    org: { name: "Acme workspace", admin: { name: "Installation Administrator" }, members: { member: { name: "Workspace Member" } } },
    env: {
      DEN_DEPLOYMENT: "self_hosted",
      DEN_API_VERSION: "0.19.2",
      OPENWORK_HELM_CHART_VERSION: "0.2.0",
      OPENWORK_HELM_APP_VERSION: "0.19.1",
      DEN_FEATURE_ADMINISTRATOR_RECOVERY: "false",
      GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "", GATEWAY_PUBLIC_BASE_URL: "",
      DEN_WORKBOT_URL: "", DEN_HEADLESS_RUNNER_URL: "",
      ...WORLD_SECRETS,
    },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const viewport = { width: 1280, height: 1000, deviceScaleFactor: 1 };
  const operator = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/diagnostics", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard/diagnostics", headless: true, viewport });
  await operator.client.send("Browser.grantPermissions", {
    origin: new URL(den.ref.webUrl).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  return {
    den,
    operator,
    member,
    async turnOnConfigExport() {
      await enableOrganizationCapabilities(seed, den.admin, { diagnosticsConfigExport: true }, organizationId);
    },
    // TODO(primitive): probe.clipboard should expose this read-only witness without browser evaluation.
    readClipboard: () => seed.evalIn(operator, () => navigator.clipboard.readText(), { awaitPromise: true }),
  };
}
export const supportedTargets = ["local/host"];
