import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

/** Schema export owns its database. Never use DATABASE_URL or a remote server. */
export async function withContractDatabase(run, options = {}) {
  const url = new URL(options.url ?? process.env.OPENWORK_CONTRACT_MYSQL_URL ?? "mysql://root:password@127.0.0.1:3306");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Contract generation requires local MySQL. OPENWORK_CONTRACT_MYSQL_URL must point at localhost; remote databases are never used.");
  }
  const name = `openwork_contract_${randomUUID().replaceAll("-", "")}`;
  url.pathname = `/${name}`;
  const require = createRequire(new URL("../ee/packages/den-db/package.json", import.meta.url));
  const connect = options.connect ?? require("mysql2/promise").createConnection;
  let connection;
  try {
    connection = await connect({
      host: url.hostname === "[::1]" ? "::1" : url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  } catch {
    throw new Error("Contract generation needs local MySQL with permission to create a disposable database. Run pnpm dev:den:mysql, or set OPENWORK_CONTRACT_MYSQL_URL to your local MySQL connection.");
  }
  let created = false;
  try {
    await connection.query(`CREATE DATABASE \`${name}\``);
    created = true;
    console.log("[contract] Preparing a disposable local database.");
    return await run(url.toString());
  } finally {
    try {
      if (created) await connection.query(`DROP DATABASE \`${name}\``);
    } finally {
      await connection.end();
    }
  }
}
