import { localMysqlIsRunning, queryDenDatabase, SkipError, type Place, type Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty Den response string");
  return value;
}

/**
 * An org with AI Gateway turned on and nothing set up yet: one admin in the
 * browser, a Marketing teammate, and a teammate outside Marketing.
 */
export async function aiGatewayAdmin(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the Gateway dashboard capability is switched on in a disposable local database");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  const den = await seed.den({
    web: true,
    schema: "migrate",
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false", GATEWAY_ENABLED: "true",
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: `AI Gateway Admin ${Date.now()}`,
      admin: { name: "Gateway Admin", email: "gateway-admin@example.test" },
      members: {
        marketer: { name: "Marketing Teammate", email: "marketing-teammate@example.test" },
        outsider: { name: "Support Teammate", email: "support-teammate@example.test" },
      },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Expected a testkit scratch database");
  const marketer = den.members.marketer;
  const outsider = den.members.outsider;
  if (!marketer || !outsider) throw new Error("Expected two synthetic teammates");

  const orgResponse = await seed.api(den.admin, "/v1/org");
  if (!orgResponse.response.ok) throw new Error(`Org lookup: HTTP ${orgResponse.response.status}`);
  const org = record(orgResponse.body);
  const orgId = text(record(org.organization).id);
  const members = Array.isArray(org.members) ? org.members.map(record) : [];
  const marketerId = text(members.find((row) => record(row.user).email === marketer.email)?.id);

  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name: "Marketing", memberIds: [marketerId] }) });
  if (!team.response.ok) throw new Error(`Team setup: HTTP ${team.response.status} ${team.text.slice(0, 200)}`);
  const marketingTeamId = text(record(record(team.body).team).id);

  await queryDenDatabase(databaseUrl, "UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.capabilities', COALESCE(JSON_EXTRACT(metadata, '$.capabilities'), JSON_OBJECT()), '$.capabilities.gatewayDashboard', JSON_EXTRACT('true', '$')) WHERE id = ?", [orgId]);

  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/gateway-providers", headless: true, viewport: { width: 1440, height: 1000 } });

  return {
    den,
    web,
    marketer,
    outsider,
    marketingTeamId,
    /** The org's gateway providers as the admin's API sees them. */
    async providers() {
      const result = await seed.api(den.admin, "/v1/inference-providers?scope=manageable");
      if (!result.response.ok) throw new Error(`Provider list: HTTP ${result.response.status}`);
      const body = record(result.body);
      return Array.isArray(body.inferenceProviders) ? body.inferenceProviders.map(record) : [];
    },
  };
}
