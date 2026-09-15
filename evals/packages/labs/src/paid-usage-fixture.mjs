/** SQL arrangements on the existing Models world's disposable database only. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export async function paidUsageFixture() {
  const url = new URL(process.env.DATABASE_URL);
  if (url.hostname !== "127.0.0.1" || !/^\/openwork_eval_/.test(url.pathname)) throw new Error("Settlement fixture requires a disposable testkit database");
  const require = createRequire(new URL("../../env/package.json", import.meta.url));
  const { createConnection } = require("mysql2/promise");
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: "Z" };
  const db = await createConnection(connection);
  const lock = await createConnection(connection);
  const orgId = process.env.MODELS_DPA_ORG_ID;
  const select = async (sql, args = []) => (await db.execute(sql, args))[0];
  let held = false;
  let ambiguousBucketId = null;
  return async (action, input) => {
    if (action === "before-upgrade") {
      await db.query("ALTER TABLE inference_usage_ledger_entries DROP COLUMN provider_usage");
      await db.query("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id serial primary key, hash text not null, created_at bigint)");
      const denRequire = createRequire(new URL("../../../../ee/packages/den-db/package.json", import.meta.url));
      const migrations = denRequire("drizzle-orm/migrator").readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../../ee/packages/den-db/drizzle", import.meta.url)) });
      await db.query("DELETE FROM __drizzle_migrations");
      for (const migration of migrations.slice(0, -1)) await db.execute("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", [migration.hash, migration.folderMillis]);
      return { columns: await select("SHOW COLUMNS FROM inference_usage_ledger_entries LIKE 'provider_usage'"), ledger: await select("SELECT id, external_job_id, occurred_at, cost_amount FROM inference_usage_ledger_entries ORDER BY id") };
    }
    if (action === "upgrade") {
      await (await import("../../../../ee/packages/den-db/dist/scripts/bootstrap.js")).bootstrapDenDb();
      return { migrations: await select("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at"), ledger: await select("SELECT id, external_job_id, occurred_at, cost_amount FROM inference_usage_ledger_entries ORDER BY id") };
    }
    if (action === "exhaust") await db.execute("UPDATE inference_org_usage_buckets SET limit_amount = used_amount WHERE organization_id = ?", [orgId]);
    if (action === "headroom") await db.execute("UPDATE inference_org_usage_buckets b JOIN inference_org_limit_policies p ON p.current_bucket_id = b.id SET b.used_amount = b.limit_amount - ? WHERE p.organization_id = ?", [input.amount, orgId]);
    if (action === "partial") {
      const [charge] = await select("SELECT c.* FROM inference_usage_ledger_bucket_charges c JOIN inference_usage_ledger_entries e ON e.id = c.ledger_entry_id WHERE e.external_job_id = ? ORDER BY c.bucket_id LIMIT 1", [input.requestId]);
      if (!charge) throw new Error("Missing repair precondition");
      await db.beginTransaction();
      await db.execute("UPDATE inference_org_usage_buckets SET used_amount = used_amount - ? WHERE id = ?", [charge.amount, charge.bucket_id]);
      await db.execute("DELETE FROM inference_usage_ledger_bucket_charges WHERE id = ?", [charge.id]);
      await db.commit();
    }
    if (action === "revoke") await db.execute("UPDATE inference_keys SET status = 'revoked', revoked_at = ? WHERE organization_id = ?", [new Date(input.at), orgId]);
    if (action === "hold-provider") {
      await lock.query("LOCK TABLES inference_org_upstream_provider_keys WRITE"); held = true;
    }
    if (action === "release-provider" && held) { await lock.query("UNLOCK TABLES"); held = false; }
    if (action === "boundary") {
      await db.execute("UPDATE inference_org_usage_buckets b JOIN inference_org_limit_policies p ON p.current_bucket_id = b.id SET b.window_end_at = ? WHERE p.organization_id = ? AND (? IS NULL OR p.window_type = ?)", [new Date(input.at), orgId, input.window ?? null, input.window ?? null]);
    }
    if (action === "ambiguous") {
      const { createDenTypeId } = await import("../../../../ee/packages/utils/dist/typeid.js");
      ambiguousBucketId = createDenTypeId("inferenceOrgUsageBucket");
      await db.execute("INSERT INTO inference_org_usage_buckets (id,organization_id,policy_id,window_start_at,window_end_at,limit_amount,used_amount) SELECT ?,b.organization_id,b.policy_id,b.window_start_at,b.window_end_at,b.limit_amount,0 FROM inference_org_usage_buckets b JOIN inference_org_limit_policies p ON p.current_bucket_id=b.id WHERE p.organization_id=? ORDER BY p.window_type LIMIT 1", [ambiguousBucketId, orgId]);
    }
    if (action === "clear-ambiguous" && ambiguousBucketId) {
      await db.execute("DELETE FROM inference_org_usage_buckets WHERE id=?", [ambiguousBucketId]);
      ambiguousBucketId = null;
    }
    if (action === "pause-ledger") await db.query("RENAME TABLE inference_usage_ledger_entries TO fixture_usage_ledger_unavailable");
    if (action === "resume-ledger") await db.query("RENAME TABLE fixture_usage_ledger_unavailable TO inference_usage_ledger_entries");
    const [pending] = await select("SELECT COUNT(*) AS count FROM information_schema.processlist WHERE ID <> CONNECTION_ID() AND INFO LIKE 'select%inference_org_upstream_provider_keys%' AND STATE LIKE '%lock%'");
    const buckets = await select("SELECT b.id, b.policy_id, b.window_start_at, b.window_end_at, b.limit_amount, b.used_amount, p.window_type, p.current_bucket_id FROM inference_org_usage_buckets b JOIN inference_org_limit_policies p ON b.policy_id = p.id WHERE b.organization_id = ? ORDER BY b.id", [orgId]);
    const ledger = action === "pause-ledger" ? [] : await select("SELECT id, organization_id, org_membership_id, inference_key_id, external_job_id, external_event_id, occurred_at, cost_amount, event_type, provider_usage FROM inference_usage_ledger_entries WHERE organization_id = ? ORDER BY id", [orgId]);
    const charges = await select("SELECT c.* FROM inference_usage_ledger_bucket_charges c JOIN inference_org_usage_buckets b ON b.id = c.bucket_id WHERE b.organization_id = ? ORDER BY c.bucket_id, c.ledger_entry_id", [orgId]);
    const keys = await select("SELECT id, org_membership_id, status, revoked_at FROM inference_keys WHERE organization_id = ? ORDER BY id", [orgId]);
    return { buckets, ledger, charges, keys, waitingForProvider: Number(pending.count) > 0 };
  };
}
