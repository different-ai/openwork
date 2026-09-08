import { createRequire } from "node:module";

// SCIM journeys require an already-enabled SSO installation. Its interactive
// authentication-test/enable flow is a separate journey, not proof claimed here.
export async function enableScimFixtureSso(database: { url: string } | undefined, organizationId: string) {
  if (!database) throw new Error("SCIM fixture requires an isolated local testkit database");
  const mysql: {
    createConnection(url: string): Promise<{
      execute(query: string, values: unknown[]): Promise<unknown>;
      end(): Promise<void>;
    }>;
  } = createRequire(import.meta.resolve("@openwork/env"))("mysql2/promise");
  const connection = await mysql.createConnection(database.url);
  try {
    await connection.execute("UPDATE sso_connection SET status = 'enabled' WHERE organization_id = ?", [organizationId]);
  } finally {
    await connection.end();
  }
}
