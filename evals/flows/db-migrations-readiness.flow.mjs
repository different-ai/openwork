import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "db-migrations-readiness";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEN_DB = join(ROOT, "ee", "packages", "den-db");
const FORBIDDEN_DEPLOY_TOOLS = ["pnpm", "tsx", "tsup", "drizzle-kit"];
const DEFAULT_DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den";
const FULLTEXT_INDEX = "memory_content_fulltext";
const BOOTSTRAP_PATH = join(DEN_DB, "dist", "scripts", "bootstrap.js");
const DIST_JOURNAL_PATH = join(DEN_DB, "dist", "drizzle", "meta", "_journal.json");
const denDbRequire = createRequire(join(DEN_DB, "package.json"));

// Narration is loaded from the approved script (evals/voiceovers/db-migrations-readiness.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const exists = (path) => access(path).then(() => true, () => false);

function readDatabaseUrl() {
  return process.env.OPENWORK_EVAL_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

function readSslSettings(parsed) {
  const sslAccept = parsed.searchParams.get("sslaccept")?.trim().toLowerCase();
  const sslMode = parsed.searchParams.get("sslmode")?.trim().toLowerCase() ?? parsed.searchParams.get("ssl-mode")?.trim().toLowerCase();

  if (!sslAccept && !sslMode) {
    return undefined;
  }

  return {
    rejectUnauthorized: sslAccept === "strict" || sslMode === "verify-ca" || sslMode === "verify-full" || sslMode === "require",
  };
}

function serverConnectionConfig(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (!parsed.hostname || !parsed.username) {
    throw new Error("Eval database URL must include host and username");
  }

  return {
    host: parsed.hostname,
    port: Number(parsed.port || "3306"),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: readSslSettings(parsed),
  };
}

function databaseUrlFor(databaseUrl, databaseName) {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe MySQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

function temporaryDatabaseName() {
  return `openwork_eval_db_migrations_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function countFromRows(rows, key) {
  const value = rows[0]?.[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

function tablesFromRows(rows) {
  return rows
    .map((row) => Object.values(row).find((value) => typeof value === "string"))
    .filter((value) => Boolean(value));
}

function buildPackageIfNeeded() {
  return spawnSync("pnpm", ["--dir", DEN_DB, "run", "build"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_HOST: "",
      DATABASE_NAME: "",
      DATABASE_PASSWORD: "",
      DATABASE_URL: "",
      DATABASE_USERNAME: "",
    },
    timeout: 120_000,
  });
}

function runBootstrap(databaseUrl) {
  return spawnSync(process.execPath, [BOOTSTRAP_PATH], {
    cwd: DEN_DB,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DEN_DB_ENCRYPTION_KEY: process.env.DEN_DB_ENCRYPTION_KEY || "eval-local-db-encryption-key-please-change-1234567890",
    },
    timeout: 120_000,
  });
}

function bootstrapLogSummary(run) {
  return run.stdout
    .split("\n")
    .filter((line) => line.startsWith("[den-db]"))
    .join("\n");
}

function shortOutput(output) {
  return output.trim().split("\n").slice(-12).join("\n");
}

function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function sliceBetween(contents, start, end) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    return "";
  }
  return contents.slice(startIndex, endIndex);
}

function rejectForbiddenDeployTools(ctx, contents, label) {
  for (const tool of FORBIDDEN_DEPLOY_TOOLS) {
    witness(ctx, !contents.includes(tool), `${label} does not reference ${tool}`);
  }
}

export default {
  id: FLOW_ID,
  title: "Den production migrations run from precompiled JavaScript and committed assets",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The Den image build prepares schema and migration assets",
      run: async (ctx) => {
        await ctx.prove("Dockerfile.den builds Den DB dist assets with a deterministic current-schema snapshot", {
          voiceover: vo[0],
          assert: async () => {
            const packageJson = await readFile(join(DEN_DB, "package.json"), "utf8");
            const buildAssets = await readFile(join(DEN_DB, "scripts", "build-assets.mjs"), "utf8");
            const denApiPackage = await readFile(join(ROOT, "ee", "apps", "den-api", "package.json"), "utf8");
            const denApiBuild = await readFile(join(ROOT, "ee", "apps", "den-api", "scripts", "build.mjs"), "utf8");
            const dockerfile = await readFile(join(ROOT, "packaging", "docker", "Dockerfile.den"), "utf8");
            const denDbBuildIndex = dockerfile.indexOf("RUN pnpm --dir /app/ee/packages/den-db run build");
            const denApiBuildIndex = dockerfile.indexOf("pnpm --dir /app/ee/apps/den-api run build");
            const build = buildPackageIfNeeded();

            witness(ctx, build.status === 0, "den-db package build emits fresh dist assets", shortOutput(build.stderr || build.stdout));
            witness(ctx, packageJson.includes("node scripts/build-assets.mjs"), "den-db build runs the asset emitter");
            witness(ctx, buildAssets.includes("drizzle-kit") && buildAssets.includes("export"), "build-time export creates the current-schema SQL snapshot");
            witness(ctx, buildAssets.includes("cpSync(migrationsDir, distMigrationsDir"), "committed migrations are copied into dist/drizzle");
            witness(ctx, denApiPackage.includes('"build:den-db": "pnpm --filter @openwork-ee/den-db build"'), "hosted Den API build exposes the den-db build step");
            witness(ctx, denApiBuild.includes('run(pnpmCommand, ["run", "build:den-db"])'), "hosted Den API build calls build:den-db before tsc");
            witness(ctx, denDbBuildIndex !== -1 && denDbBuildIndex < denApiBuildIndex, "Dockerfile.den builds den-db before den-api");
            witness(ctx, await exists(BOOTSTRAP_PATH), "dist/scripts/bootstrap.js exists after the build");
            witness(ctx, await exists(join(DEN_DB, "dist", "current-schema.sql")), "dist/current-schema.sql exists after the build");
            witness(ctx, await exists(DIST_JOURNAL_PATH), "dist/drizzle/meta/_journal.json exists after the build");
            ctx.output("den-db build wiring", [
              packageJson.split("\n").find((line) => line.includes("\"build\"")),
              denApiPackage.split("\n").filter((line) => line.includes("build:den-db") || line.includes('"start"')).join("\n"),
              buildAssets.split("\n").filter((line) => line.includes("current-schema.sql") || line.includes("distMigrationsDir") || line.includes("drizzle-kit")).join("\n"),
              dockerfile.split("\n").filter((line) => line.includes("den-db run build") || line.includes("den-api run build")).join("\n"),
            ].join("\n\n"));
          },
        });
      },
    },
    {
      name: "The Helm hook runs node against the precompiled dist runner",
      run: async (ctx) => {
        await ctx.prove("The production Helm migration path invokes node dist only, with no deploy-time TypeScript toolchain", {
          voiceover: vo[1],
          assert: async () => {
            const values = await readFile(join(ROOT, "packaging", "helm", "openwork-ee", "values.yaml"), "utf8");
            const migrationBlock = sliceBetween(values, "migrations:\n", "\ningress:");
            const bootstrap = await readFile(join(DEN_DB, "scripts", "bootstrap.ts"), "utf8");
            const publishWorkflow = await readFile(join(ROOT, ".github", "workflows", "publish-ee-images.yml"), "utf8");

            witness(ctx, migrationBlock.includes("command:\n    - node"), "Helm migration command is node");
            witness(ctx, migrationBlock.includes("/app/ee/packages/den-db/dist/scripts/bootstrap.js"), "Helm migration args point at dist/scripts/bootstrap.js");
            witness(ctx, publishWorkflow.includes("Assert Den DB migration assets"), "Den API PR image smoke asserts migration assets before health smoke");
            witness(ctx, publishWorkflow.includes("/app/ee/packages/den-db/dist/current-schema.sql"), "Den API image smoke checks the schema snapshot artifact");
            witness(ctx, publishWorkflow.includes("/app/ee/packages/den-db/dist/drizzle/meta/_journal.json"), "Den API image smoke checks the migration journal artifact");
            rejectForbiddenDeployTools(ctx, migrationBlock, "Helm migration defaults");
            rejectForbiddenDeployTools(ctx, bootstrap, "Production bootstrap source");
            witness(ctx, bootstrap.includes("drizzle-orm/mysql2/migrator"), "bootstrap imports Drizzle ORM's mysql2 migrator");
            ctx.output("Helm migration defaults", migrationBlock.trim());
          },
        });
      },
    },
    {
      name: "Bootstrap preserves fresh, baselined, and pending-only behavior",
      run: async (ctx) => {
        await ctx.prove("The runner initializes empty databases, baselines legacy schemas, and lets the ORM apply only pending migrations", {
          voiceover: vo[2],
          assert: async () => {
            const bootstrap = await readFile(join(DEN_DB, "scripts", "bootstrap.ts"), "utf8");
            const journal = JSON.parse(await readFile(DIST_JOURNAL_PATH, "utf8"));
            const expectedMigrationCount = Array.isArray(journal.entries) ? journal.entries.length : 0;
            const mysql = denDbRequire("mysql2/promise");
            const sourceDatabaseUrl = readDatabaseUrl();
            const config = serverConnectionConfig(sourceDatabaseUrl);
            const databaseName = temporaryDatabaseName();
            const server = await mysql.createConnection(config);

            try {
              await server.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
              const tempDatabaseUrl = databaseUrlFor(sourceDatabaseUrl, databaseName);
              const firstRun = runBootstrap(tempDatabaseUrl);
              witness(ctx, firstRun.status === 0, "first bootstrap run exits successfully", shortOutput(firstRun.stderr || firstRun.stdout));

              const database = await mysql.createConnection({ ...config, database: databaseName });
              try {
                const [tableRows] = await database.query("show tables");
                const tables = tablesFromRows(tableRows);
                const [ledgerRows] = await database.query("select count(*) as count from `__drizzle_migrations`");
                const ledgerCount = countFromRows(ledgerRows, "count");
                const [fulltextRows] = await database.query(
                  "select count(*) as count from information_schema.STATISTICS where table_schema = database() and table_name = 'memory' and index_name = ?",
                  [FULLTEXT_INDEX],
                );
                const fulltextCount = countFromRows(fulltextRows, "count");

                witness(ctx, bootstrap.includes("applicationTables.length === 0"), "fresh databases are detected by having no application tables");
                witness(ctx, bootstrap.includes("await applyCurrentSchema(executor)"), "fresh databases apply the current-schema snapshot");
                witness(ctx, tables.includes("organization") && tables.includes("memory"), "fresh bootstrap creates application schema tables", `tables=${tables.length}`);
                witness(ctx, ledgerCount === expectedMigrationCount, "fresh bootstrap records every committed migration in the ledger", `ledger=${ledgerCount}, expected=${expectedMigrationCount}`);
                witness(ctx, fulltextCount === 1, "fresh bootstrap creates the memory.content FULLTEXT index", `fulltext indexes=${fulltextCount}`);

                const secondRun = runBootstrap(tempDatabaseUrl);
                witness(ctx, secondRun.status === 0, "second bootstrap run exits successfully", shortOutput(secondRun.stderr || secondRun.stdout));

                const [secondLedgerRows] = await database.query("select count(*) as count from `__drizzle_migrations`");
                const [secondFulltextRows] = await database.query(
                  "select count(*) as count from information_schema.STATISTICS where table_schema = database() and table_name = 'memory' and index_name = ?",
                  [FULLTEXT_INDEX],
                );
                const secondLedgerCount = countFromRows(secondLedgerRows, "count");
                const secondFulltextCount = countFromRows(secondFulltextRows, "count");

                witness(ctx, secondLedgerCount === expectedMigrationCount, "idempotent second run does not add duplicate ledger entries", `ledger=${secondLedgerCount}, expected=${expectedMigrationCount}`);
                witness(ctx, secondFulltextCount === 1, "idempotent second run leaves exactly one FULLTEXT index", `fulltext indexes=${secondFulltextCount}`);
                witness(ctx, secondRun.stdout.includes("memory.content FULLTEXT index already present"), "second run observes the existing FULLTEXT index");
                witness(ctx, bootstrap.includes("await migrate(db, { migrationsFolder })"), "existing ledgers use the ORM migrator for pending migrations");
                ctx.output("Temporary MySQL bootstrap proof", [
                  `temporary database: ${databaseName}`,
                  `expected migration entries from journal: ${expectedMigrationCount}`,
                  `created tables: ${tables.length}`,
                  `first run logs:\n${bootstrapLogSummary(firstRun)}`,
                  `second run logs:\n${bootstrapLogSummary(secondRun)}`,
                ].join("\n"));
              } finally {
                await database.end();
              }
            } finally {
              await server.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
              await server.end();
            }
          },
        });
      },
    },
    {
      name: "FULLTEXT indexes are ensured after migrations",
      run: async (ctx) => {
        await ctx.prove("The precompiled runner finishes by repairing required FULLTEXT indexes after migration work", {
          voiceover: vo[3],
          assert: async () => {
            const bootstrap = await readFile(join(DEN_DB, "scripts", "bootstrap.ts"), "utf8");
            const fulltext = await readFile(join(DEN_DB, "src", "fulltext.ts"), "utf8");
            const tests = await readFile(join(DEN_DB, "test", "migration-readiness.test.ts"), "utf8");
            const denApiPackage = await readFile(join(ROOT, "ee", "apps", "den-api", "package.json"), "utf8");
            const startLine = denApiPackage.split("\n").find((line) => line.includes('"start"')) ?? "";
            const migrateWorkflow = await readFile(join(ROOT, ".github", "workflows", "den-db-migrate.yml"), "utf8");

            const migrateIndex = bootstrap.indexOf("await runCommittedMigrations()");
            const fulltextIndex = bootstrap.indexOf("await ensureFulltextIndexes(indexExecutor)");
            witness(ctx, migrateIndex !== -1 && fulltextIndex !== -1 && migrateIndex < fulltextIndex, "FULLTEXT repair runs after committed migrations");
            witness(ctx, fulltext.includes("CREATE FULLTEXT INDEX"), "FULLTEXT creation is idempotent and explicit");
            witness(ctx, startLine.includes('"start": "node dist/main.js"'), "hosted Den API start runs the server only");
            witness(ctx, !startLine.includes("db:migrate") && !startLine.includes("db:bootstrap") && !startLine.includes("bootstrap.js"), "hosted Den API start does not silently migrate");
            witness(ctx, migrateWorkflow.includes('paths:\n      - "ee/packages/den-db/drizzle/**"'), "Den DB Migrate owns hosted committed-migration pushes");
            witness(ctx, migrateWorkflow.includes("run_with_ddl_retry pnpm --filter @openwork-ee/den-db db:migrate"), "Den DB Migrate explicitly invokes db:migrate");
            witness(ctx, tests.includes("schema snapshot contains SQL only"), "focused tests cover build artifact wiring without a live DB");
            rejectForbiddenDeployTools(ctx, sliceBetween(await readFile(join(ROOT, "packaging", "helm", "openwork-ee", "values.yaml"), "utf8"), "migrations:\n", "\ningress:"), "Final Helm migration path");
            ctx.output("FULLTEXT finish", bootstrap.split("\n").filter((line) => line.includes("runCommittedMigrations") || line.includes("ensureFulltextIndexes")).join("\n"));
          },
        });
      },
    },
  ],
};
