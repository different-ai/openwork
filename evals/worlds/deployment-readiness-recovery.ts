import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Seed } from "@openwork/env";
import { managedDeploymentSchema } from "@openwork/types/den/managed-deployments";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export function deploymentReadinessRecovery(seed: Seed) { return deploymentFixture(seed, false); }
export function deploymentParentReadLock(seed: Seed) { return deploymentFixture(seed, true); }

/** Fixture publication coordinates are never fetched or executed. Only local target and handoff records are made. */
async function deploymentFixture(seed: Seed, parentGuard: boolean) {
  await using setup = new AsyncDisposableStack();
  const [api, web] = await allocateFreePorts(2);
  if (!api || !web) throw new Error("Missing isolated deployment ports");
  const faults = setup.use(await faultProxy({ apiUrl: `http://127.0.0.1:${api}`, webUrl: `http://127.0.0.1:${web}` }));
  const den = setup.use(await seed.den({
    ports: { api, web }, webApiBase: faults.ref.apiUrl, trustedOrigins: [faults.ref.webUrl],
    env: { DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_GCP_VERSION: "0.18.58",
      DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL: "https://storage.googleapis.com/test-release/tutorial.md?generation=1",
      DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: "https://storage.googleapis.com/test-release/bundle.tar.gz?generation=2",
      DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256: "a".repeat(64) },
    org: { name: "Deployment recovery", admin: { name: "Deployment owner" } },
  }));
  const orgId = await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true, managedDeploymentsGcp: true });
  let deploymentId: string | null = null;
  if (parentGuard) {
    const recorded = await seed.api(den.admin, "/v1/managed-deployments", { method: "POST", body: JSON.stringify({
      provider: "gcp", name: "Observed deployment", domainName: "observed.example.test", ownerEmail: "owner@example.test",
      target: { projectId: "openwork-fixture", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-test" },
    }) });
    if (!recorded.response.ok) throw new Error(`Record observation fixture: ${recorded.response.status}`);
    deploymentId = managedDeploymentSchema.parse(recorded.body).id;
  } else {
    await faults.faults.status("/api/den/v1/managed-deployments", 404, { method: "POST", times: 1, body: { error: "feature_disabled" } });
    await faults.faults.status("/api/den/v1/managed-deployments", 503, { method: "POST", times: 1, body: { error: "release_not_configured" } });
  }
  const browser = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/deployments", headless: true, viewport: { width: 1440, height: 1400 } });
  // A separate operator uses the real local admin API through its shipped UI.
  // The parent-guard case has no injected GET/POST refusals.
  const operator = parentGuard ? await seed.web({ den, signedInAs: den.admin, startPath: `/admin/organizations/${orgId}/features`, headless: true, viewport: { width: 1440, height: 1400 } }) : null;
  const owned = setup.move();
  return { den, web: browser, operator, orgId, deploymentId, faults, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
