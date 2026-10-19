import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withContractDatabase } from "../../../../scripts/den-contract-database.mjs";

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const dbDir = fileURLToPath(new URL("../../../packages/den-db", import.meta.url));
await withContractDatabase(async (databaseUrl) => {
  const env = { ...process.env, DATABASE_URL: databaseUrl, DEN_TEST_DATABASE_URL: databaseUrl,
    DB_MODE: "mysql", DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890" };
  execFileSync(process.execPath, ["--conditions=development", "--import", "tsx",
    "./node_modules/drizzle-kit/bin.cjs", "push", "--force"], { cwd: dbDir, env, stdio: "inherit" });
  execFileSync("bun", ["--conditions=development", "test", "test/bun/gateway-local-key-share.test.ts"],
    { cwd: apiDir, env, stdio: "inherit" });
});
