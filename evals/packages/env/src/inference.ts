import { execFile, spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { allocateFreePort } from "@openwork/cdp";
import { startInferenceWitness } from "@openwork/labs";
import type { Place } from "./place.ts";
import { ephemeralDatabaseName, localMysqlIsRunning } from "./place.ts";
import { SkipError } from "./needs.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const encryptionSecret = "local-dev-db-encryption-key-please-change-1234567890";
const exec = promisify(execFile);
const id = (prefix: string) => `${prefix}_0${randomBytes(16).toString("hex").slice(0, 25)}`;

function encrypted(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(encryptionSecret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
}

/** Real HTTP service and SQL persistence; only upstream generation is a fixture. */
export async function managedInference(place: Place) {
  if (place.kind !== "local") throw new SkipError("managed inference fixture requires a local MySQL service and loopback provider");
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL is not reachable at OPENWORK_EVAL_MYSQL_URL or the default local port");
  const stack = new AsyncDisposableStack();
  try {
    const database = stack.use(await place.db(ephemeralDatabaseName("inference_eval")));
    await exec("pnpm", ["--filter", "@openwork-ee/den-db", "db:push"], {
      cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: database.url, DEN_DB_ENCRYPTION_KEY: encryptionSecret },
    });
    const sql = await createConnection({ uri: database.url, timezone: "Z" });
    stack.defer(() => sql.end());
    const witness = stack.use(await startInferenceWitness());
    const port = await allocateFreePort();
    const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
      cwd: `${root}/ee/apps/inference`, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
        PORT: String(port), DB_MODE: "mysql", DATABASE_URL: database.url,
        DEN_DB_ENCRYPTION_KEY: encryptionSecret, OPENROUTER_UPSTREAM_URL: witness.url,
        INFERENCE_WEBHOOK_SECRET: "fixture-webhook-secret", INFERENCE_UPSTREAM_TIMEOUT_MS: "2000", INFERENCE_STREAM_IDLE_MS: "1000",
      },
    });
    let logs = "";
    child.stdout?.on("data", (chunk) => { logs += String(chunk); });
    child.stderr?.on("data", (chunk) => { logs += String(chunk); });
    stack.defer(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    while (true) {
      if (await fetch(`${url}/health`).then((response) => response.ok).catch(() => false)) break;
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Inference fixture failed to start: ${logs.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const identities: { organizationId: string; memberId: string; keyId: string; key: string; providerKey: string }[] = [];
    for (let index = 0; index < 3; index++) {
      const organizationId = index === 1 ? identities[0]!.organizationId : id("org");
      const memberId = id("om");
      const keyId = id("ink");
      const key = `ow_inf_${randomBytes(32).toString("base64url")}`;
      const providerKey = index === 1 ? identities[0]!.providerKey : `fixture-provider-${index}`;
      if (index !== 1) {
        await sql.execute("INSERT INTO organization (id,name,slug,metadata) VALUES (?,?,?,?)", [organizationId, `Inference ${index}`, organizationId, JSON.stringify({ inference: { enabled: true, tier: "tier1" } })]);
        await sql.execute("INSERT INTO inference_org_upstream_provider_keys (id,organization_id,provider,encrypted_api_key,status) VALUES (?,?, 'openrouter',?,'active')", [id("iopk"), organizationId, encrypted(providerKey)]);
        for (const window of ["five_hour", "weekly", "monthly"]) {
          await sql.execute("INSERT INTO inference_org_limit_policies (id,organization_id,window_type,reset_strategy,anchor_at) VALUES (?,?,?,'activity_based',?)", [id("iolp"), organizationId, window, new Date()]);
        }
      }
      await sql.execute("INSERT INTO member (id,organization_id,role) VALUES (?,?,'member')", [memberId, organizationId]);
      await sql.execute("INSERT INTO inference_keys (id,organization_id,org_membership_id,key_hash,status) VALUES (?,?,?,?,'active')", [keyId, organizationId, memberId, createHash("sha256").update(key).digest("hex")]);
      identities.push({ organizationId, memberId, keyId, key, providerKey });
    }
    const legacy = identities[0];
    if (!legacy) throw new Error("Missing migration fixture identity");
    await sql.execute("INSERT INTO inference_usage_ledger_entries (id,organization_id,org_membership_id,inference_key_id,external_job_id,cost_amount,event_type,occurred_at) VALUES (?,?,?,?, 'legacy-fixture',123,'legacy_fixture',NOW(3))", [id("iule"), legacy.organizationId, legacy.memberId, legacy.keyId]);
    // Only this disposable database is restored to the pre-change column shape.
    // Exercise the checked-in additive migration with an existing ledger row.
    await sql.query("ALTER TABLE inference_usage_ledger_entries DROP COLUMN provider_usage");
    await sql.query(await readFile(`${root}/ee/packages/den-db/drizzle/0090_managed_usage_facts.sql`, "utf8"));
    return {
      url, witness, identities, logs: () => logs,
      async rows(query: string, values: string[] = []) { const [rows] = await sql.execute<RowDataPacket[]>(query, values); return rows; },
      async change(query: string, values: (string | number | Date)[] = []) { await sql.execute(query, values); },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
