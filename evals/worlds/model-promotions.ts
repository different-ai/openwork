import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { Den } from "@openwork/env";
import { eventually } from "@openwork/testkit";

export async function verifyPromotionFixtureEmail(den: Den, email: string) {
  if (!/^[a-z0-9+@._-]+$/.test(email)) throw new Error("Invalid fixture email");
  if (den.placement?.kind === "daytona") {
    await execInSandbox(defaultDaytonaExec, den.placement.sandboxId,
      `mysql -h127.0.0.1 -uroot -ppassword openwork_den -e "UPDATE user SET email_verified=1 WHERE email=CHAR(${[...email].map((c) => c.charCodeAt(0)).join(",")})"`,
      { context: "Verify promotion fixture email", timeoutMs: 15000 });
    return;
  }
  if (!den.database) throw new Error("An isolated database is required");
  const connection = await createConnection(den.database.url);
  try { await connection.execute("UPDATE user SET email_verified=1 WHERE email=?", [email]); }
  finally { await connection.end(); }
}

export async function promotionInference(den: Den, witnessUrl: string) {
  const origin = new URL(witnessUrl).origin;
  let stop = async () => {};
  if (den.placement?.kind === "daytona") {
    await execInSandbox(defaultDaytonaExec, den.placement.sandboxId,
      "cd /workspace && (nohup env NODE_OPTIONS=--conditions=development OPENWORK_DEV_MODE=1 PORT=8799 DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den DEN_DB_ENCRYPTION_KEY=daytona-den-db-encryption-key-please-change-1234567890 OPENROUTER_UPSTREAM_URL=http://127.0.0.1:3986/api/v1 pnpm --filter @openwork-ee/inference exec tsx src/server.ts > /tmp/model-promotion-inference.log 2>&1 < /dev/null &)",
      { context: "Start isolated promotion inference", timeoutMs: 30000 });
    // The owned Den sandbox disposes its inference child with the other services.
  } else {
    if (!den.database) throw new Error("An isolated database is required");
    const child = spawn("pnpm", ["--filter", "@openwork-ee/inference", "exec", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), detached: true, stdio: "ignore",
      env: { ...process.env, NODE_OPTIONS: "--conditions=development", OPENWORK_DEV_MODE: "1", PORT: "8799", DATABASE_URL: den.database.url,
        DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890", OPENROUTER_UPSTREAM_URL: `${origin}/api/v1` },
    });
    stop = async () => { if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  }
  const base = `${origin}/__promotion/inference`;
  await eventually(async () => fetch(`${base}/health`).then((r) => r.status).catch(() => 0), { within: 45000, intervalMs: 500, until: (code) => code === 200, label: "Promotion inference cold boot" });
  return { url: `${base}/api/v1`, async [Symbol.asyncDispose]() { await stop(); } };
}
