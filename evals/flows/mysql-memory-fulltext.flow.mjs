/**
 * Internal demo: MySQL memory timestamp normalization before FULLTEXT creation.
 *
 * Runs app-less (requiresApp: false). When Docker is available, the flow starts
 * a disposable MySQL 8 container in strict sql_mode and drives the fresh
 * bootstrap plus existing-upgrade commands against real databases.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mysql-memory-fulltext";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PASSWORD = "password";
const DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const STRICT_SQL_MODE = "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  containerName: null,
  port: null,
  freshDb: "ow_memory_fulltext_fresh",
  upgradeDb: "ow_memory_fulltext_upgrade",
  initialSqlMode: "",
  freshBootstrap: null,
  upgradeMigrate: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, lines = 80) {
  const all = String(text).split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
  });
  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = [
    `$ ${[command, ...args].join(" ")}`,
    stdout.trim(),
    stderr.trim(),
    result.error ? result.error.message : "",
  ].filter(Boolean).join("\n");
  if (!options.allowFailure && status !== 0) {
    throw new Error(`Command failed (${status}): ${command} ${args.join(" ")}\n${tail(output)}`);
  }
  return { status, stdout, stderr, output };
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, assertion + (actual ? ` (actual: ${actual})` : ""));
}

function cleanupMysql() {
  if (!state.containerName) return null;
  const result = runCommand("docker", ["rm", "-f", state.containerName], { allowFailure: true });
  state.containerName = null;
  state.port = null;
  return result;
}

process.once("exit", () => {
  if (state.containerName) {
    spawnSync("docker", ["rm", "-f", state.containerName], { stdio: "ignore" });
  }
});

function databaseUrl(database) {
  return `mysql://root:${DB_PASSWORD}@127.0.0.1:${state.port}/${database}`;
}

function denDbEnv(database) {
  return {
    DATABASE_URL: databaseUrl(database),
    DEN_DB_ENCRYPTION_KEY,
  };
}

function runDenDbScript(args, database, options = {}) {
  return runCommand("pnpm", ["--filter", "@openwork-ee/den-db", ...args], {
    env: denDbEnv(database),
    timeoutMs: options.timeoutMs ?? 360_000,
    allowFailure: options.allowFailure,
  });
}

function mysqlExec(database, sql, options = {}) {
  if (!state.containerName) throw new Error("MySQL container is not running");
  const args = [
    "exec",
    state.containerName,
    "mysql",
    "-h127.0.0.1",
    "--protocol=tcp",
    "-uroot",
    `-p${DB_PASSWORD}`,
    "--batch",
    "--raw",
    "--skip-column-names",
  ];
  if (database) args.push(database);
  args.push("-e", sql);
  return runCommand("docker", args, options);
}

async function ensureMysql(ctx) {
  if (state.port) return;

  state.containerName = `ow-mysql-memory-fulltext-${process.pid}-${Date.now()}`;
  runCommand("docker", ["rm", "-f", state.containerName], { allowFailure: true });
  const started = runCommand("docker", [
    "run",
    "--name",
    state.containerName,
    "-e",
    `MYSQL_ROOT_PASSWORD=${DB_PASSWORD}`,
    "-p",
    "127.0.0.1::3306",
    "-d",
    "mysql:8.0",
    `--sql-mode=${STRICT_SQL_MODE}`,
  ], { timeoutMs: 240_000 });

  let ready = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    ready = runCommand("docker", ["exec", state.containerName, "mysqladmin", "ping", "-h127.0.0.1", "--protocol=tcp", "-uroot", `-p${DB_PASSWORD}`], {
      allowFailure: true,
      timeoutMs: 5_000,
    });
    if (ready.status === 0) break;
    await sleep(2_000);
  }
  if (!ready || ready.status !== 0) {
    throw new Error(`MySQL did not become ready.\n${ready ? tail(ready.output) : "No ping output"}`);
  }

  const port = runCommand("docker", ["port", state.containerName, "3306/tcp"]);
  const portMatch = port.stdout.trim().match(/:(\d+)$/);
  if (!portMatch) throw new Error(`Could not parse MySQL port from: ${port.stdout}`);
  state.port = portMatch[1];
  state.initialSqlMode = mysqlExec(null, "SELECT @@GLOBAL.sql_mode;").stdout.trim();

  ctx.output("MySQL 8 strict-mode container", tail([started.output, port.output, state.initialSqlMode].join("\n"), 40));
}

function createDatabase(name) {
  mysqlExec(null, `DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\`;`);
}

function memoryDefaults(database) {
  return mysqlExec(null, `
    SELECT table_name, column_default
    FROM information_schema.COLUMNS
    WHERE table_schema = '${database}'
      AND table_name IN ('memory', 'memory_context')
      AND column_name = 'created_at'
    ORDER BY table_name;
  `);
}

function createLegacyMemoryTables(defaultClause) {
  return `
    CREATE TABLE memory_context (
      id varchar(64) NOT NULL,
      memory_id varchar(64) NOT NULL,
      citation json,
      snippet text NOT NULL,
      origin enum('active_conversation','searched_conversation'),
      created_at timestamp(3) NOT NULL ${defaultClause},
      PRIMARY KEY (id)
    );
    CREATE TABLE memory (
      id varchar(64) NOT NULL,
      user_id varchar(64) NOT NULL,
      org_id varchar(64) NOT NULL,
      scope enum('user','org') NOT NULL DEFAULT 'user',
      content text NOT NULL,
      source varchar(64) NOT NULL,
      tags json,
      created_at timestamp(3) NOT NULL ${defaultClause},
      updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id)
    );
  `;
}

function seedUpgradeRows() {
  mysqlExec(state.upgradeDb, `
    INSERT INTO memory (id, user_id, org_id, scope, content, source, created_at, updated_at)
    VALUES ('mem_preserve', 'user_preserve', 'org_preserve', 'user', 'Fulltext strict timestamp proof', 'test', '2024-01-02 03:04:05.123', '2024-01-02 03:04:05.123');
    INSERT INTO memory_context (id, memory_id, snippet, created_at)
    VALUES ('ctx_preserve', 'mem_preserve', 'Preserve this timestamp', '2024-02-03 04:05:06.789');
  `);
}

async function prepareUpgradePath(ctx) {
  if (state.upgradeMigrate) return;

  createDatabase(state.upgradeDb);
  const legacyCreate = mysqlExec(state.upgradeDb, createLegacyMemoryTables("DEFAULT (now())"), { allowFailure: true });
  if (legacyCreate.status !== 0) {
    createDatabase(state.upgradeDb);
    const fallbackCreate = mysqlExec(state.upgradeDb, createLegacyMemoryTables(""));
    ctx.output("Legacy fixture fallback", tail([legacyCreate.output, fallbackCreate.output].join("\n"), 60));
  }
  seedUpgradeRows();

  const baseline = runDenDbScript(["db:baseline", "--", "--yes", "--through", "0040_rapid_lady_bullseye"], state.upgradeDb, {
    timeoutMs: 240_000,
    allowFailure: true,
  });
  ctx.output("Upgrade baseline through 0040", tail(baseline.output, 80));
  witness(ctx, baseline.status === 0, "Existing database was baselined through 0040", String(baseline.status));

  state.upgradeMigrate = runDenDbScript(["db:migrate"], state.upgradeDb, {
    timeoutMs: 360_000,
    allowFailure: true,
  });
  ctx.output("Upgrade db:migrate output", tail(state.upgradeMigrate.output, 100));
  witness(ctx, state.upgradeMigrate.status === 0, "db:migrate completed on the existing-upgrade fixture", String(state.upgradeMigrate.status));
}

export default {
  id: FLOW_ID,
  title: "MySQL memory timestamp normalization before FULLTEXT creation",
  spec: "evals/voiceovers/mysql-memory-fulltext.md",
  kind: "internal",
  requiresApp: false,
  precondition: async () => {
    const docker = runCommand("docker", ["info"], { allowFailure: true, timeoutMs: 30_000 });
    return docker.status === 0 ? null : "Docker is required for this MySQL 8 proof flow.";
  },
  steps: [
    {
      name: "Strict MySQL fresh bootstrap uses portable created_at defaults",
      run: async (ctx) => {
        await ctx.prove("A strict-mode MySQL database starts with DEFAULT CURRENT_TIMESTAMP(3) on memory created_at columns", {
          voiceover: vo[0],
          action: async () => {
            await ensureMysql(ctx);
            createDatabase(state.freshDb);
            state.freshBootstrap = runDenDbScript(["db:bootstrap"], state.freshDb, {
              timeoutMs: 420_000,
              allowFailure: true,
            });
            ctx.output("Fresh db:bootstrap output", tail(state.freshBootstrap.output, 100));
          },
          assert: async () => {
            witness(ctx, state.freshBootstrap?.status === 0, "db:bootstrap completed on an empty strict-mode MySQL database", String(state.freshBootstrap?.status));
            const defaults = memoryDefaults(state.freshDb);
            ctx.output("Fresh memory created_at defaults", defaults.stdout.trim());
            witness(ctx, defaults.stdout.includes("memory\tCURRENT_TIMESTAMP(3)"), "memory.created_at default is CURRENT_TIMESTAMP(3)", defaults.stdout.trim());
            witness(ctx, defaults.stdout.includes("memory_context\tCURRENT_TIMESTAMP(3)"), "memory_context.created_at default is CURRENT_TIMESTAMP(3)", defaults.stdout.trim());
          },
        });
      },
    },
    {
      name: "Existing rows keep created_at values during upgrade normalization",
      run: async (ctx) => {
        await ctx.prove("Existing memory and memory_context rows keep their original created_at values while the migration normalizes defaults", {
          voiceover: vo[1],
          action: async () => {
            await ensureMysql(ctx);
            await prepareUpgradePath(ctx);
          },
          assert: async () => {
            const rows = mysqlExec(state.upgradeDb, `
              SELECT 'memory', DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') FROM memory WHERE id = 'mem_preserve'
              UNION ALL
              SELECT 'memory_context', DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') FROM memory_context WHERE id = 'ctx_preserve'
              ORDER BY 1;
            `);
            ctx.output("Preserved created_at values", rows.stdout.trim());
            witness(ctx, rows.stdout.includes("memory\t2024-01-02 03:04:05.123000"), "memory.created_at retained the seeded value", rows.stdout.trim());
            witness(ctx, rows.stdout.includes("memory_context\t2024-02-03 04:05:06.789000"), "memory_context.created_at retained the seeded value", rows.stdout.trim());
          },
        });
      },
    },
    {
      name: "FULLTEXT creation keeps sql_mode strict",
      run: async (ctx) => {
        await ctx.prove("The memory FULLTEXT index exists and the solution never relaxes sql_mode", {
          voiceover: vo[2],
          action: async () => {
            await ensureMysql(ctx);
            await prepareUpgradePath(ctx);
          },
          assert: async () => {
            const fulltext = mysqlExec(null, `
              SELECT index_name, index_type
              FROM information_schema.STATISTICS
              WHERE table_schema = '${state.upgradeDb}'
                AND table_name = 'memory'
                AND index_name = 'memory_content_fulltext';
            `);
            const finalSqlMode = mysqlExec(null, "SELECT @@GLOBAL.sql_mode;").stdout.trim();
            const fulltextSource = await readFile(join(ROOT, "ee/packages/den-db/src/fulltext.ts"), "utf8");
            const migrationSource = await readFile(join(ROOT, "ee/packages/den-db/drizzle/0041_spicy_silk_fever.sql"), "utf8");
            ctx.output("FULLTEXT and sql_mode evidence", [fulltext.stdout.trim(), `initial: ${state.initialSqlMode}`, `final: ${finalSqlMode}`].join("\n"));
            witness(ctx, fulltext.stdout.includes("memory_content_fulltext\tFULLTEXT"), "memory_content_fulltext exists as a FULLTEXT index", fulltext.stdout.trim());
            witness(ctx, finalSqlMode.includes("NO_ZERO_DATE") && finalSqlMode.includes("NO_ZERO_IN_DATE"), "MySQL global sql_mode remains strict with NO_ZERO_DATE and NO_ZERO_IN_DATE", finalSqlMode);
            witness(ctx, finalSqlMode === state.initialSqlMode, "The proof database global sql_mode was not relaxed", finalSqlMode);
            witness(ctx, !/sql_mode/i.test(fulltextSource + migrationSource), "The normalization and migration code do not set sql_mode");
          },
        });
      },
    },
    {
      name: "Fresh and upgrade verification commands pass",
      run: async (ctx) => {
        await ctx.prove("Fresh bootstrap and upgraded databases both pass the memory schema verifier", {
          voiceover: vo[3],
          action: async () => {
            await ensureMysql(ctx);
            await prepareUpgradePath(ctx);
          },
          assert: async () => {
            const freshVerify = runDenDbScript(["db:verify-memory"], state.freshDb, {
              timeoutMs: 360_000,
              allowFailure: true,
            });
            const upgradeVerify = runDenDbScript(["db:verify-memory"], state.upgradeDb, {
              timeoutMs: 360_000,
              allowFailure: true,
            });
            ctx.output("Fresh db:verify-memory", tail(freshVerify.output, 100));
            ctx.output("Upgrade db:verify-memory", tail(upgradeVerify.output, 100));
            witness(ctx, freshVerify.status === 0, "Fresh bootstrap path passed db:verify-memory", String(freshVerify.status));
            witness(ctx, upgradeVerify.status === 0, "Existing-upgrade path passed db:verify-memory", String(upgradeVerify.status));
            const cleanup = cleanupMysql();
            if (cleanup) ctx.output("MySQL cleanup", cleanup.output);
          },
        });
      },
    },
  ],
};
