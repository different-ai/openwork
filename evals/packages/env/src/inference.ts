import { execFile, spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
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

/** Real HTTP service with disposable baseline SQL for auth; generation is local. */
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
      cwd: `${root}/ee/apps/gateway`, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
        PORT: String(port), DB_MODE: "mysql", DATABASE_URL: database.url,
        DEN_DB_ENCRYPTION_KEY: encryptionSecret, OPENROUTER_UPSTREAM_URL: witness.url,
        GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(witness.url).origin,
        INFERENCE_WEBHOOK_SECRET: "fixture-webhook-secret", INFERENCE_UPSTREAM_TIMEOUT_MS: "1000", INFERENCE_STREAM_IDLE_MS: "1000",
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
    const identity = {
      organizationId: id("org"), memberId: id("om"), keyId: id("ink"),
      key: `ow_inf_${randomBytes(32).toString("base64url")}`, providerKey: "fixture-provider-secret",
    };
    const { organizationId, memberId, keyId, key, providerKey } = identity;
    await sql.execute("INSERT INTO organization (id,name,slug,metadata) VALUES (?,?,?,?)", [organizationId, "Inference transport", organizationId, JSON.stringify({ inference: { enabled: true, tier: "tier1" } })]);
    await sql.execute("INSERT INTO inference_org_upstream_provider_keys (id,organization_id,provider,encrypted_api_key,status) VALUES (?,?, 'openrouter',?,'active')", [id("iopk"), organizationId, encrypted(providerKey)]);
    for (const window of ["five_hour", "weekly", "monthly"]) {
      await sql.execute("INSERT INTO inference_org_limit_policies (id,organization_id,window_type,reset_strategy,anchor_at) VALUES (?,?,?,'activity_based',?)", [id("iolp"), organizationId, window, new Date()]);
    }
    await sql.execute("INSERT INTO member (id,organization_id,role) VALUES (?,?,'member')", [memberId, organizationId]);
    await sql.execute("INSERT INTO inference_keys (id,organization_id,org_membership_id,key_hash,status) VALUES (?,?,?,?,'active')", [keyId, organizationId, memberId, createHash("sha256").update(key).digest("hex")]);
    return {
      url, witness, identity, logs: () => logs,
      async denyManagedModels() {
        await sql.execute("UPDATE organization SET metadata=? WHERE id=?", [JSON.stringify({ inference: { enabled: true, tier: "tier1" }, dpaSigned: true }), organizationId]);
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
