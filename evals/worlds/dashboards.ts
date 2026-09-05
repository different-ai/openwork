import { queryDenDatabase, type Seed } from "@openwork/env";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { isRecord, records } from "./library.ts";

/** The witness MCP App every tile in this world launches: one tool, required `jql` input. */
export const dashboardAppTool = {
  name: "search_issues_using_jql",
  title: "Search issues (JQL)",
} as const;

/**
 * One organization dashboard with no tiles yet, a connection to a witness MCP
 * that exposes exactly one App-visible launch tool, and the admin signed in to
 * that dashboard's Den Web detail page. Everything a spec needs to prove how
 * the Add app picker treats a second tile of the same App.
 */
export async function emptyDashboardWithOneApp(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: { name: `Dashboard tiles ${stamp}`, admin: { name: "Dashboard Tile Admin" } },
    mocks: { tracker: seed.mock({ allowUnauthenticatedMcp: true, appToolName: dashboardAppTool.name }) },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: `Issue tracker ${stamp}`,
    url: den.mocks.tracker.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  const catalog = await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/mcp-apps`);
  const catalogTools = (isRecord(catalog.body) ? records(catalog.body.apps) : [])
    .map((app) => (typeof app.toolName === "string" ? app.toolName : ""));
  if (!catalog.response.ok) {
    throw new Error(`Listing the connection's MCP Apps failed: HTTP ${catalog.response.status} ${catalog.text.slice(0, 500)}`);
  }

  const dashboardName = `JQL board ${stamp}`;
  const created = await seed.api(den.admin, "/v1/dashboards", {
    method: "POST",
    body: JSON.stringify({ name: dashboardName, elements: [] }),
  });
  const createdItem = isRecord(created.body) && isRecord(created.body.item) ? created.body.item : null;
  const dashboardId = createdItem && typeof createdItem.id === "string" ? createdItem.id : "";
  if (created.response.status !== 201 || !dashboardId) {
    throw new Error(`Creating the dashboard failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }

  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: `/dashboard/dashboards/${dashboardId}`,
    headless: true,
  });

  return { den, web, connection, catalogTools, dashboardId, dashboardName };
}

/** A new team can opt into cloud access without a payment provider. */
export async function optionalCloudTrial(seed: Seed) {
  const den = await seed.den({
    org: { name: `Cloud trial ${Date.now()}`, admin: { name: "Trial Owner" } },
    env: {
      DEN_OPENWORK_WEB_ENABLED: "true", DEN_OPENWORK_CLOUD_TRIAL_ENABLED: "true", OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "", SMTP_HOST: "", STRIPE_SECRET_KEY: "",
      OPENWORK_CLOUD_TRIAL_POLL_MS: "1000",
    },
  });
  const organizations = await seed.api(den.admin, "/v1/me/orgs");
  const orgId = isRecord(organizations.body) ? records(organizations.body.orgs)[0]?.id : undefined;
  if (typeof orgId !== "string") throw new Error("Expected isolated trial organization");
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/onboarding", headless: true, viewport: { width: 1280, height: 1100 } });
  return {
    den, web, orgId,
    async ageTrial(phase: "ending" | "expired") {
      const statement = phase === "ending"
        ? "UPDATE org_cloud_trials SET started_at = DATE_SUB(NOW(3), INTERVAL 6 DAY), expires_at = DATE_ADD(NOW(3), INTERVAL 12 HOUR) WHERE organization_id = "
        : "UPDATE org_cloud_trials SET started_at = DATE_SUB(NOW(3), INTERVAL 8 DAY), expires_at = DATE_SUB(NOW(3), INTERVAL 1 DAY) WHERE organization_id = ";
      if (den.database) {
        await queryDenDatabase(den.database.url, `${statement}?`, [orgId]);
        return;
      }
      if (den.placement?.kind !== "daytona") throw new Error("Trial aging needs an isolated Den database");
      // Daytona's isolated fixture database uses the documented test credentials.
      // Hex encoding keeps the identity out of shell and SQL quoting contexts.
      const identity = Buffer.from(orgId).toString("hex");
      await execInSandbox(defaultDaytonaExec, den.placement.sandboxId,
        `mysql -uroot -ppassword openwork_den -e "${statement}0x${identity}"`,
        { timeoutMs: 30_000, context: "age only the trial fixture organization" });
    },
  };
}
