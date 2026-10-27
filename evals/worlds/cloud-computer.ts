import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** The real Web app, with rollout changes made through the platform-admin API.
 * This world deliberately has no desktop image: it proves rollout and recovery
 * UI, while the provider check exercises the actual Daytona desktop separately. */
export async function cloudComputerWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Cloud computer studio", admin: { name: "Workspace Owner" } } });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { computerUse: true });
  const { app } = await signedInAppWeb(seed, { name: "cloud-computer", den, webPort, workspacePath: seed.tmpPath("cloud-computer-workspace") });
  const session = await seed.session(app, { title: "Work in the cloud browser" });
  const setRemote = async (enabled: boolean) => {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { remoteComputers: enabled } }) });
    if (!result.response.ok) throw new Error(`Changing the cloud computer rollout failed: HTTP ${result.response.status}`);
  };
  return { app, den, session, setRemote };
}
