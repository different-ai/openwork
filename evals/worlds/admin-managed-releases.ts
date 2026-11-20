import type { Place, Seed } from "@openwork/env";
import { z } from "zod";

const reportSchema = z.object({ history: z.array(z.object({
  action: z.string(), version: z.string().nullable(), actor: z.string(), manifestSha256: z.string().nullable(),
  qualification: z.object({ freshInstallUrl: z.string(), approvedUpdateUrl: z.string() }).nullable(),
})) });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a fixture API object");
  return Object.fromEntries(Object.entries(value));
}

export async function adminManagedReleasesWorld(seed: Seed, { place }: { place: Place }) {
  const source = "https://managed-fixture.s3.us-east-1.amazonaws.com/releases/aws/";
  const fixture = place.kind === "daytona" ? "file:///workspace/evals/packages/labs/src/managed-installer-release-preload.mjs" : new URL("../packages/labs/src/managed-installer-release-preload.mjs", import.meta.url).href;
  // The base product has no fixture module. The checksum witness below requires
  // it on the changed product; an absent fixture can never satisfy verification.
  const preload = `import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';if(existsSync(fileURLToPath(${JSON.stringify(fixture)})))await import(${JSON.stringify(fixture)})`;
  const den = await seed.den({ web: true, env: {
    DEN_DEPLOYMENT: "cloud", DB_MODE: "mysql", DATABASE_REDIS_URL: "",
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    // This proof switches to single-administrator approval, which only the operator can allow.
    DEN_MANAGED_INSTALLER_SINGLE_ADMIN_APPROVAL: "true",
    DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify({ version: "1.2.2", templateUrl: `${source}1.2.2/cloudformation.json?versionId=old-template`, bundleUrl: `${source}1.2.2/bundle.tar.gz?versionId=old-bundle`, bundleSha256: "b".repeat(64) }),
    RESEND_API_KEY: "", LOOPS_API_KEY: "", SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "",
    OTEL_SDK_DISABLED: "true", NEXT_TELEMETRY_DISABLED: "1",
  }, org: { name: "Release workspace", admin: { name: "Platform administrator" }, members: { member: { name: "Workspace member" } } } });
  const org = record(record((await seed.api(den.admin, "/v1/org")).body).organization);
  if (typeof org.id !== "string") throw new Error("The fixture organization is missing");
  const enabled = await seed.api(den.admin, `/v1/admin/organizations/${org.id}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { managedDeployments: true } }) });
  if (!enabled.response.ok) throw new Error("Could not enable the fixture's managed deployments");
  const created = await seed.api(den.admin, "/v1/managed-deployments", { method: "POST", body: JSON.stringify({ provider: "aws", name: "Pending installation", domainName: "pending.example.test", ownerEmail: den.admin.email, target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", runtimeProfile: "legacy" } }) });
  const deployment = record(created.body);
  if (!created.response.ok || typeof deployment.id !== "string") throw new Error("Could not arrange a pending installation");
  const pending = await seed.api(den.admin, `/v1/managed-deployments/${deployment.id}/launch`, { method: "POST", body: JSON.stringify({ kind: "install" }) });
  if (!pending.response.ok) throw new Error("Could not arrange its original approval");
  const pendingRun = record(record(pending.body).deployment);
  const originalRun = record(pendingRun.run);
  if (originalRun.version !== "1.2.2" || typeof originalRun.id !== "string") throw new Error("The original approval was not pinned to the environment release");
  const viewport = { width: 1280, height: 900 };
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/managed-deployments", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/managed-deployments", headless: true, viewport });
  return {
    den, admin, member, source,
    async report() {
      const result = await seed.api(den.admin, "/v1/admin/managed-releases");
      if (!result.response.ok) throw new Error("Could not read the release report");
      return reportSchema.parse(result.body);
    },
    async readiness() {
      const result = await seed.api(den.admin, "/v1/managed-deployments/configuration");
      if (!result.response.ok) throw new Error("Could not read offered installer versions");
      const providers = record(result.body).providers;
      if (!Array.isArray(providers)) throw new Error("Provider readiness is missing");
      return providers.map(record).find(provider => provider.provider === "aws");
    },
    async pendingApproval() {
      const result = await seed.api(den.admin, "/v1/managed-deployments");
      const rows = record(result.body).deployments;
      if (!result.response.ok || !Array.isArray(rows)) throw new Error("Could not read the pending installation");
      const saved = rows.map(record).find(row => row.id === deployment.id);
      if (!saved) throw new Error("The pending installation disappeared");
      return { installedVersion: saved.installedVersion, availableVersion: saved.availableVersion, run: record(saved.run), originalRunId: originalRun.id };
    },
    async memberAccess() {
      const read = await seed.api(den.members.member, "/v1/admin/managed-releases");
      const write = await seed.api(den.members.member, "/v1/admin/managed-releases/reset", { method: "POST", body: JSON.stringify({ provider: "aws", expectedRevision: "0".repeat(64) }) });
      return { read: read.response.status, write: write.response.status };
    },
    async artifactReads() {
      const log = await den.apiLog();
      return log.split("\n").filter(line => line.includes("Managed installer fixture:"));
    },
  };
}
