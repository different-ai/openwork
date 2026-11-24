import { randomUUID } from "node:crypto";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference";
import { isRecord } from "./library.ts";

export async function founderFreeSpendWorld(seed: Seed) {
  const den = await seed.den({ web: true, env: { DEN_ORG_MODE: "multi_org" }, org: { name: "Founder workspace", admin: { name: "Workspace founder" } } });
  const database = den.database?.url;
  if (!database || !new URL(database).pathname.startsWith("/openwork_eval_")) throw new Error("Expected an isolated Den database");
  async function create(name: string) {
    const result = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name }) });
    const org = isRecord(result.body) ? result.body.organization : null;
    if (result.response.status !== 201 || !isRecord(org) || typeof org.id !== "string") throw new Error("Could not create the founder's organization");
    return org.id;
  }
  const first = await create("First workspace");
  const second = await create("Second workspace");
  async function settle(organizationId: string, dollars: number) {
    await queryDenDatabase(database!, `INSERT INTO inference_free_usage
      (request_id, principal_hash, organization_id, org_membership_id, inference_key_id, model_id, amount, estimated)
      SELECT ?, 'fixture-founder', m.organization_id, m.id, 'fixture-key', 'example-model', ?, false
      FROM member m JOIN user u ON u.id = m.user_id WHERE m.organization_id = ? AND u.email = ?`,
    [randomUUID(), dollars * INFERENCE_USAGE_CONVERSION_FACTOR, organizationId, den.admin.email]);
  }
  await settle(first, 3);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/security", headless: true, viewport: { width: 1360, height: 1000 } });
  return { web, settleSecond: () => settle(second, 2) };
}
