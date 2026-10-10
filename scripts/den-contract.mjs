#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withContractDatabase } from "./den-contract-database.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
function pnpm(args, env = process.env) {
  // pnpm supplies its JS entry point, avoiding .cmd invocation on Windows.
  const entry = process.env.npm_execpath;
  execFileSync(entry ? process.execPath : "pnpm", entry ? [entry, ...args] : args, { cwd: root, stdio: "inherit", env });
}

await withContractDatabase(async (databaseUrl) => {
  const env = { ...process.env, DATABASE_URL: databaseUrl, DB_MODE: "mysql", DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890" };
  pnpm(["--filter", "@openwork/mcp-apps", "build"], env);
  pnpm(["--filter", "@openwork-ee/den-db", "exec", "node", "--conditions=development", "--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "push", "--force"], env);
  pnpm(["api:snapshot"], env);
  pnpm(["--filter", "@openwork/sdk", "generate", "--input", fileURLToPath(new URL("../packages/docs/openapi.json", import.meta.url))], env);
});
