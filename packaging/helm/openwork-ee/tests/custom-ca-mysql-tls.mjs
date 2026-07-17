import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const chartDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(chartDir, "..", "..", "..");
const denDbDir = join(repoRoot, "ee", "packages", "den-db");
const denDbPackage = join(denDbDir, "package.json");
const denDbRequire = createRequire(denDbPackage);
const mysql = denDbRequire("mysql2/promise");
const bootstrapPath = join(denDbDir, "dist", "scripts", "bootstrap.js");
const currentSchemaPath = join(denDbDir, "dist", "current-schema.sql");
const denDbIndexPath = join(denDbDir, "dist", "index.js");
const image = process.env.OPENWORK_EVAL_MYSQL_IMAGE?.trim() || "mysql:8.4";
const containerName = `openwork-custom-ca-mysql-${process.pid}-${Date.now()}`;
const tmp = mkdtempSync(join(tmpdir(), "openwork-custom-ca-mysql-"));
const certsDir = join(tmp, "certs");
const caKey = join(certsDir, "ca.key");
const caCert = join(certsDir, "ca.crt");
const serverKey = join(certsDir, "server.key");
const serverCsr = join(certsDir, "server.csr");
const serverCert = join(certsDir, "server.crt");
const opensslConfig = join(tmp, "openssl.cnf");
const mysqlConfig = join(tmp, "tls.cnf");
const databaseName = "openwork_den";
const databaseUser = "openwork";
const databasePassword = "openwork_tls_test_password";
let containerStarted = false;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
    ...options,
  });
}

function ensureSuccess(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function runOpenSsl(args) {
  ensureSuccess(run("openssl", args), `openssl ${args.join(" ")}`);
}

function ensureBuildArtifacts() {
  if (existsSync(bootstrapPath) && existsSync(currentSchemaPath) && existsSync(denDbIndexPath)) {
    return;
  }

  const result = run("pnpm", ["--dir", denDbDir, "run", "build"], { timeout: 240_000 });
  ensureSuccess(result, "pnpm --dir ee/packages/den-db run build");
  console.log("Built @openwork-ee/den-db migration artifacts");
}

function generateCertificates() {
  mkdirSync(certsDir, { recursive: true });
  writeFileSync(
    opensslConfig,
    `[req]
distinguished_name = dn
prompt = no
req_extensions = v3_req
[dn]
CN = localhost
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
DNS.2 = mysql.private.test
IP.1 = 127.0.0.1
`,
  );

  runOpenSsl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=OpenWork Test MySQL CA", "-keyout", caKey, "-out", caCert]);
  runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-config", opensslConfig]);
  runOpenSsl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", serverCert, "-days", "1", "-extensions", "v3_req", "-extfile", opensslConfig]);
  chmodSync(serverKey, 0o644);
  chmodSync(serverCert, 0o644);
  chmodSync(caCert, 0o644);

  writeFileSync(
    mysqlConfig,
    `[mysqld]
ssl-ca=/etc/mysql/certs/ca.crt
ssl-cert=/etc/mysql/certs/server.crt
ssl-key=/etc/mysql/certs/server.key
require_secure_transport=ON
tls_version=TLSv1.2,TLSv1.3
`,
  );
  chmodSync(mysqlConfig, 0o644);
  console.log("Generated private CA and MySQL server certificate with SAN DNS:localhost, DNS:mysql.private.test, IP:127.0.0.1");
}

function docker(args, options = {}) {
  return run("docker", args, { timeout: 240_000, ...options });
}

function startMysqlContainer() {
  const result = docker([
    "run",
    "--rm",
    "--detach",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::3306",
    "--env",
    "MYSQL_ROOT_PASSWORD=openwork_root_password",
    "--env",
    "MYSQL_ROOT_HOST=%",
    "--env",
    `MYSQL_DATABASE=${databaseName}`,
    "--env",
    `MYSQL_USER=${databaseUser}`,
    "--env",
    `MYSQL_PASSWORD=${databasePassword}`,
    "--volume",
    `${certsDir}:/etc/mysql/certs:ro`,
    "--volume",
    `${mysqlConfig}:/etc/mysql/conf.d/tls.cnf:ro`,
    image,
  ]);
  ensureSuccess(result, `docker run ${image}`);
  containerStarted = true;
  console.log(`Started TLS-enabled MySQL container ${containerName} from ${image}`);
}

function mappedPort() {
  const result = docker(["port", containerName, "3306/tcp"]);
  ensureSuccess(result, "docker port");
  const endpoint = result.stdout.trim().split("\n").find(Boolean);
  const port = endpoint?.split(":").pop();
  if (!port) {
    throw new Error(`Unable to resolve mapped MySQL port from: ${result.stdout}`);
  }
  return Number(port);
}

async function waitForMysql(port) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 90_000) {
    try {
      const connection = await mysql.createConnection({
        host: "127.0.0.1",
        port,
        user: databaseUser,
        password: databasePassword,
        database: databaseName,
        ssl: { rejectUnauthorized: false },
      });
      await connection.query("select 1");
      await connection.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  const logs = docker(["logs", containerName], { timeout: 30_000 });
  throw new Error(`MySQL container did not become ready: ${lastError}\n${logs.stdout}\n${logs.stderr}`);
}

function strictDatabaseUrl(port) {
  return `mysql://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}?sslmode=verify-full`;
}

function redactedDatabaseUrl(port) {
  return `mysql://${databaseUser}:REDACTED@127.0.0.1:${port}/${databaseName}?sslmode=verify-full`;
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  return env;
}

function runOpenWorkMysqlQuery(databaseUrl, query, extraEnv = {}) {
  const source = `
import { createRequire } from "node:module";
const mysql = createRequire(process.argv[1])("mysql2/promise");
const { parseMySqlConnectionConfig } = await import(process.argv[2]);
const connection = await mysql.createConnection(parseMySqlConnectionConfig(process.argv[3]));
try {
  const [rows] = await connection.query(process.argv[4]);
  console.log(JSON.stringify(rows));
} finally {
  await connection.end();
}
`;

  return run(process.execPath, ["--input-type=module", "-e", source, denDbPackage, pathToFileURL(denDbIndexPath).href, databaseUrl, query], {
    env: childEnv(extraEnv),
    timeout: 90_000,
  });
}

function runBootstrap(databaseUrl) {
  return run(process.execPath, [bootstrapPath], {
    cwd: denDbDir,
    env: childEnv({
      DATABASE_URL: databaseUrl,
      DEN_DB_ENCRYPTION_KEY: "openwork-custom-ca-mysql-tls-test-key-1234567890",
      NODE_EXTRA_CA_CERTS: caCert,
      OPENWORK_DEN_DB_ENV_PATH: join(tmp, "does-not-exist.env"),
    }),
    timeout: 180_000,
  });
}

function cleanup() {
  if (containerStarted) {
    docker(["rm", "-f", containerName], { timeout: 30_000 });
  }
  rmSync(tmp, { recursive: true, force: true });
}

try {
  ensureBuildArtifacts();
  generateCertificates();
  startMysqlContainer();
  const port = mappedPort();
  await waitForMysql(port);
  const databaseUrl = strictDatabaseUrl(port);
  console.log(`TLS MySQL endpoint ready at ${redactedDatabaseUrl(port)}`);

  const withoutCa = runOpenWorkMysqlQuery(databaseUrl, "select 1 as ok");
  if (withoutCa.status === 0) {
    throw new Error("Strict OpenWork/mysql2 unexpectedly connected without NODE_EXTRA_CA_CERTS");
  }
  const withoutCaError = `${withoutCa.stdout}\n${withoutCa.stderr}`.trim();
  if (!/certificate|verify|self-signed|unable/i.test(withoutCaError)) {
    throw new Error(`Strict OpenWork/mysql2 failed for a non-certificate reason:\n${withoutCaError}`);
  }
  const certificateError = withoutCaError.split("\n").find((line) => /certificate|verify|self-signed|unable/i.test(line)) ?? withoutCaError.split("\n").find(Boolean);
  console.log(`Strict OpenWork/mysql2 without custom CA: rejected (${certificateError})`);

  const bootstrap = runBootstrap(databaseUrl);
  ensureSuccess(bootstrap, "OpenWork migration bootstrap with NODE_EXTRA_CA_CERTS");
  console.log("OpenWork migration bootstrap completed with NODE_EXTRA_CA_CERTS and strict DATABASE_URL");
  console.log(bootstrap.stdout.trim());

  const query = runOpenWorkMysqlQuery(
    databaseUrl,
    "select (select count(*) from information_schema.tables where table_schema = database()) as table_count, (select count(*) from `__drizzle_migrations`) as migration_count",
    { NODE_EXTRA_CA_CERTS: caCert },
  );
  ensureSuccess(query, "OpenWork/mysql2 strict post-migration query with NODE_EXTRA_CA_CERTS");
  const rows = JSON.parse(query.stdout.trim());
  const tableCount = Number(rows[0]?.table_count ?? 0);
  const migrationCount = Number(rows[0]?.migration_count ?? 0);
  if (tableCount <= 0 || migrationCount <= 0) {
    throw new Error(`Expected migrated OpenWork tables and migration ledger rows, got ${query.stdout}`);
  }
  console.log(`OpenWork/mysql2 strict query succeeded after migration: tables=${tableCount}, migrations=${migrationCount}`);
} finally {
  cleanup();
}
