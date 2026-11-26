import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

function contractMySqlUrl(value) {
  const url = new URL(value ?? process.env.OPENWORK_CONTRACT_MYSQL_URL ?? "mysql://root:password@127.0.0.1:3306");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Contract generation requires local MySQL. OPENWORK_CONTRACT_MYSQL_URL must point at localhost; remote databases are never used.");
  }
  return url;
}

function connectContractMySql(url, connect) {
  const require = createRequire(new URL("../ee/packages/den-db/package.json", import.meta.url));
  return (connect ?? require("mysql2/promise").createConnection)({
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectTimeout: 3000,
  });
}

/** Why contract generation cannot run here, or null when local MySQL accepts the connection. */
export async function contractDatabaseUnavailable(options = {}) {
  let url;
  try {
    url = contractMySqlUrl(options.url);
  } catch (error) {
    return error.message;
  }
  try {
    await (await connectContractMySql(url, options.connect)).end();
    return null;
  } catch {
    return "local MySQL is not reachable (run pnpm dev:den:mysql, or set OPENWORK_CONTRACT_MYSQL_URL)";
  }
}

/** Schema export owns its database. Never use DATABASE_URL or a remote server. */
export async function withContractDatabase(run, options = {}) {
  const url = contractMySqlUrl(options.url);
  const name = `openwork_contract_${randomUUID().replaceAll("-", "")}`;
  url.pathname = `/${name}`;
  let connection;
  try {
    connection = await connectContractMySql(url, options.connect);
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
