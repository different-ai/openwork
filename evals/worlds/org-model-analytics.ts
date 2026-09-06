import { queryDenDatabase, type Seed } from "@openwork/env";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";

export async function orgModelAnalyticsWorld(seed: Seed) {
  const den = await seed.den({ web: true, org: { name: "Analytics team" }, env: { DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false" } });
  const web = await seed.web({ den, signedInAs: den.admin,
    startPath: "/dashboard/analytics", headless: true, viewport: { width: 1440, height: 1100 } });
  return { den, web, async analyticsStoreUnavailable(unavailable: boolean) {
    // This world owns the disposable store. Preserve its rows while making
    // analytics reads fail, leaving authentication and subscription storage up.
    const sql = unavailable ? "RENAME TABLE telemetry_event TO telemetry_event_unavailable" : "RENAME TABLE telemetry_event_unavailable TO telemetry_event";
    if (den.placement?.kind === "daytona") {
      const script = `import { createConnection } from "/workspace/ee/packages/den-db/node_modules/mysql2/promise.js";
        const connection = await createConnection("mysql://root:password@127.0.0.1:3306/openwork_den");
        try { await connection.query(${JSON.stringify(sql)}); } finally { await connection.end(); }`;
      const encoded = Buffer.from(script).toString("base64");
      const result = await execInSandbox(defaultDaytonaExec, den.placement.sandboxId, `printf %s ${encoded} | base64 -d | node --input-type=module`, { timeoutMs: 15_000, context: "Arrange analytics storage availability" });
      if (result.code !== 0) throw new Error("Could not arrange analytics storage availability");
    } else {
      if (!den.database) throw new Error("Analytics outage proof requires its own isolated database");
      await queryDenDatabase(den.database.url, sql);
    }
  } };
}
