import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "runtime-db-primitive";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = join(ROOT, "apps", "server");
const SERVER_SRC = join(SERVER_DIR, "src");
const RUN_TIMEOUT_MS = 120_000;
const WORKSPACE_ID = "ws_runtime_db_primitive_flow";

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

type HarnessPaths = {
  root: string;
  dbPath: string;
  harnessPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: string): void {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function moduleUrl(name: string): string {
  return pathToFileURL(join(SERVER_SRC, name)).href;
}

function harnessSource(): string {
  return `import { join } from "node:path";
import { installCloudPlugin, readInstalledCloudPlugins } from ${JSON.stringify(moduleUrl("cloud-plugins.ts"))};
import { readOpenworkWorkspaceConfig, writeOpenworkWorkspaceConfig } from ${JSON.stringify(moduleUrl("openwork-workspace-config-store.ts"))};
import { openRuntimeSqliteDatabase, runtimeDbPath, runtimeStorageDir } from ${JSON.stringify(moduleUrl("runtime-db.ts"))};
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from ${JSON.stringify(moduleUrl("runtime-opencode-config-store.ts"))};
import { readSessionGroupState, writeSessionGroupState } from ${JSON.stringify(moduleUrl("session-groups.ts"))};

const mode = process.argv[2] ?? "";
const root = process.env.RUNTIME_DB_PRIMITIVE_ROOT;
const dbPath = process.env.OPENWORK_RUNTIME_DB;
const workspaceId = ${JSON.stringify(WORKSPACE_ID)};

if (!root || !dbPath) throw new Error("runtime DB primitive harness needs RUNTIME_DB_PRIMITIVE_ROOT and OPENWORK_RUNTIME_DB");

function serverConfig(configPath = join(root, "server.json")) {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath,
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: workspaceId, name: "Runtime DB Primitive", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: 1,
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function writeSessionAndWorkspace(config) {
  await writeSessionGroupState(config, workspaceId, {
    groups: [{ id: "grp_flow", label: "Flow group" }],
    assignments: { ses_flow: "grp_flow" },
  });
  await writeOpenworkWorkspaceConfig(config, workspaceId, (current) => ({
    ...current,
    workspace: { label: "Flow workspace config" },
  }));
}

async function writeRuntimeAndCloud(config) {
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => ({
    ...current,
    plugin: ["flow-runtime-plugin"],
    mcp: { flow: { type: "remote", url: "https://runtime-db-primitive.example/mcp" } },
  }));
  await installCloudPlugin({
    serverConfig: config,
    workspaceId,
    workspaceRoot: root,
    marketplaceId: "marketplace_flow",
    marketplace: { id: "marketplace_flow", name: "Flow Marketplace", updatedAt: null },
    resolved: {
      plugin: { id: "plugin_flow", name: "Flow Runtime Plugin", description: null, updatedAt: null },
      memberships: [],
    },
  });
}

async function readSessionAndWorkspace(config) {
  const session = await readSessionGroupState(config, workspaceId);
  const workspace = await readOpenworkWorkspaceConfig(config, workspaceId);
  return {
    groupLabel: session.state.groups[0]?.label ?? null,
    assignment: session.state.assignments.ses_flow ?? null,
    workspaceLabel: workspace.workspace?.label ?? null,
  };
}

async function readRuntimeAndCloud(config) {
  const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
  const cloud = await readInstalledCloudPlugins(config, workspaceId);
  return {
    runtimePlugin: runtime.plugin?.[0] ?? null,
    runtimeMcpUrl: runtime.mcp?.flow?.url ?? null,
    cloudPluginName: cloud.plugins.plugin_flow?.name ?? null,
    marketplacePluginIds: cloud.marketplaces.marketplace_flow?.pluginIds ?? [],
  };
}

function print(value) {
  console.log(JSON.stringify(value));
}

const config = serverConfig();

if (mode === "paths") {
  delete process.env.OPENWORK_RUNTIME_DB;
  const defaultPath = runtimeDbPath(config);
  process.env.OPENWORK_RUNTIME_DB = ` + "` ${dbPath} `" + `;
  const overridePath = runtimeDbPath(config);
  const storageDir = runtimeStorageDir(config);
  const connection = await openRuntimeSqliteDatabase(overridePath);
  connection.sqlite.run("CREATE TABLE primitive_path_check (id TEXT PRIMARY KEY NOT NULL)");
  connection.sqlite.query("INSERT INTO primitive_path_check (id) VALUES (?)").run("ok");
  connection.close();
  print({ mode, defaultPath, overridePath, storageDir, driver: connection.kind });
} else if (mode === "write-session-workspace") {
  await writeSessionAndWorkspace(config);
  print({ mode, wrote: ["session_group_states", "openwork_workspace_configs"] });
} else if (mode === "read-session-workspace") {
  print({ mode, ...(await readSessionAndWorkspace(config)) });
} else if (mode === "write-runtime-cloud") {
  await writeRuntimeAndCloud(config);
  print({ mode, wrote: ["runtime_opencode_configs", "cloud_plugin_install_configs"] });
} else if (mode === "read-runtime-cloud") {
  print({ mode, ...(await readRuntimeAndCloud(config)) });
} else if (mode === "write-all") {
  await writeSessionAndWorkspace(config);
  await writeRuntimeAndCloud(config);
  print({ mode, wrote: "all" });
} else if (mode === "read-all") {
  print({ mode, ...(await readSessionAndWorkspace(config)), ...(await readRuntimeAndCloud(config)) });
} else {
  throw new Error(` + "`Unknown runtime DB primitive harness mode: ${mode}`" + `);
}
`;
}

async function createHarness(): Promise<HarnessPaths> {
  const root = await mkdtemp(join(tmpdir(), "openwork-runtime-db-primitive-flow-"));
  const harnessPath = join(root, "runtime-db-primitive-harness.mjs");
  await writeFile(harnessPath, harnessSource(), "utf8");
  return { root, dbPath: join(root, "runtime.sqlite"), harnessPath };
}

function runHarness(paths: HarnessPaths, mode: string): SpawnSyncReturns<string> {
  return spawnSync("bun", [paths.harnessPath, mode], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENWORK_RUNTIME_DB: paths.dbPath,
      RUNTIME_DB_PRIMITIVE_ROOT: paths.root,
    },
    timeout: RUN_TIMEOUT_MS,
  });
}

function commandOutput(run: SpawnSyncReturns<string>): string {
  const parts: string[] = [];
  if (run.stdout.trim()) parts.push(run.stdout.trim());
  if (run.stderr.trim()) parts.push(run.stderr.trim());
  if (run.error) parts.push(run.error.message);
  return parts.join("\n");
}

function parseHarnessJson(run: SpawnSyncReturns<string>): Record<string, unknown> {
  const line = run.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("Harness did not print JSON");
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("Harness JSON was not an object");
  return parsed;
}

function recordRow(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) throw new Error("Expected a SQLite row object");
  return row;
}

function readTableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .flatMap((row: unknown) => (isRecord(row) && typeof row.name === "string" ? [row.name] : []));
  } finally {
    db.close();
  }
}

function readTextCell(dbPath: string, sql: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = recordRow(db.prepare(sql).get());
    return typeof row.value === "string" ? row.value : null;
  } finally {
    db.close();
  }
}

function readJsonCell(dbPath: string, sql: string): Record<string, unknown> {
  const text = readTextCell(dbPath, sql);
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

export default defineFlow({
  id: FLOW_ID,
  title: "Runtime DB primitive keeps server stores durable and isolated",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Resolve one runtime DB path before opening",
      run: async (ctx) => {
        const paths = await createHarness();
        try {
          let run: SpawnSyncReturns<string> | null = null;
          await ctx.prove("The server resolves the canonical runtime DB path and opens the chosen file", {
            voiceover: vo[0],
            action: async () => {
              run = runHarness(paths, "paths");
            },
            assert: async () => {
              if (!run) throw new Error("paths harness did not run");
              witness(ctx, run.status === 0, "Path harness exits 0", commandOutput(run));
              const output = parseHarnessJson(run);
              witness(ctx, output.defaultPath === join(paths.root, "runtime.sqlite"), "Default path resolves next to server.json", String(output.defaultPath));
              witness(ctx, output.overridePath === paths.dbPath, "OPENWORK_RUNTIME_DB override wins after trimming", String(output.overridePath));
              witness(ctx, output.storageDir === paths.root, "runtimeStorageDir points at the runtime DB directory", String(output.storageDir));
              witness(ctx, output.driver === "bun", "Harness opened the active Bun SQLite driver through the primitive", String(output.driver));
              witness(ctx, (await stat(paths.dbPath)).isFile(), "Opening the primitive created the runtime.sqlite file", paths.dbPath);
              ctx.output("harness path", paths.harnessPath);
              ctx.output("$ bun runtime-db-primitive-harness.mjs paths", commandOutput(run));
            },
          });
        } finally {
          await rm(paths.root, { recursive: true, force: true });
        }
      },
    },
    {
      name: "Session groups and workspace config stay isolated",
      run: async (ctx) => {
        const paths = await createHarness();
        try {
          let writeRun: SpawnSyncReturns<string> | null = null;
          let readRun: SpawnSyncReturns<string> | null = null;
          await ctx.prove("Session groups and workspace configuration persist in separate runtime DB tables", {
            voiceover: vo[1],
            action: async () => {
              writeRun = runHarness(paths, "write-session-workspace");
              readRun = runHarness(paths, "read-session-workspace");
            },
            assert: async () => {
              if (!writeRun || !readRun) throw new Error("session/workspace harness did not run");
              witness(ctx, writeRun.status === 0 && readRun.status === 0, "Session/workspace write and read harnesses exit 0", [commandOutput(writeRun), commandOutput(readRun)].join("\n"));
              const output = parseHarnessJson(readRun);
              const tables = readTableNames(paths.dbPath);
              const sessionRow = readJsonCell(paths.dbPath, "SELECT state_json AS value FROM session_group_states WHERE workspace_id = 'ws_runtime_db_primitive_flow'");
              const workspaceRow = readJsonCell(paths.dbPath, "SELECT config_json AS value FROM openwork_workspace_configs WHERE workspace_id = 'ws_runtime_db_primitive_flow'");
              witness(ctx, tables.includes("session_group_states"), "session_group_states table exists", tables.join(", "));
              witness(ctx, tables.includes("openwork_workspace_configs"), "openwork_workspace_configs table exists", tables.join(", "));
              witness(ctx, output.groupLabel === "Flow group" && output.assignment === "grp_flow", "Session group state reads back through the store", JSON.stringify(output));
              witness(ctx, output.workspaceLabel === "Flow workspace config", "Workspace config reads back through its store", JSON.stringify(output));
              witness(ctx, Array.isArray(sessionRow.groups) && isRecord(workspaceRow.workspace), "Raw DB rows keep domain JSON in separate schemas", JSON.stringify({ sessionRow, workspaceRow }));
              ctx.output("$ bun runtime-db-primitive-harness.mjs write-session-workspace", commandOutput(writeRun));
              ctx.output("$ bun runtime-db-primitive-harness.mjs read-session-workspace", commandOutput(readRun));
              ctx.output("SQLite tables", tables.join("\n"));
            },
          });
        } finally {
          await rm(paths.root, { recursive: true, force: true });
        }
      },
    },
    {
      name: "Runtime config and cloud plugin state share the primitive only",
      run: async (ctx) => {
        const paths = await createHarness();
        try {
          let writeRun: SpawnSyncReturns<string> | null = null;
          let readRun: SpawnSyncReturns<string> | null = null;
          await ctx.prove("Runtime OpenCode configuration and cloud plugin installs use the primitive without sharing rows", {
            voiceover: vo[2],
            action: async () => {
              writeRun = runHarness(paths, "write-runtime-cloud");
              readRun = runHarness(paths, "read-runtime-cloud");
            },
            assert: async () => {
              if (!writeRun || !readRun) throw new Error("runtime/cloud harness did not run");
              witness(ctx, writeRun.status === 0 && readRun.status === 0, "Runtime/cloud write and read harnesses exit 0", [commandOutput(writeRun), commandOutput(readRun)].join("\n"));
              const output = parseHarnessJson(readRun);
              const tables = readTableNames(paths.dbPath);
              const runtimeRow = readJsonCell(paths.dbPath, "SELECT config_json AS value FROM runtime_opencode_configs WHERE workspace_id = 'ws_runtime_db_primitive_flow'");
              const cloudRow = readJsonCell(paths.dbPath, "SELECT config_json AS value FROM cloud_plugin_install_configs WHERE workspace_id = 'ws_runtime_db_primitive_flow'");
              witness(ctx, tables.includes("runtime_opencode_configs"), "runtime_opencode_configs table exists", tables.join(", "));
              witness(ctx, tables.includes("cloud_plugin_install_configs"), "cloud_plugin_install_configs table exists", tables.join(", "));
              witness(ctx, output.runtimePlugin === "flow-runtime-plugin", "Runtime OpenCode plugin reads back through its store", JSON.stringify(output));
              witness(ctx, output.runtimeMcpUrl === "https://runtime-db-primitive.example/mcp", "Runtime OpenCode MCP reads back through its store", JSON.stringify(output));
              witness(ctx, output.cloudPluginName === "Flow Runtime Plugin", "Cloud plugin install state reads back through its store", JSON.stringify(output));
              witness(ctx, Array.isArray(runtimeRow.plugin) && isRecord(cloudRow.plugins), "Raw DB rows keep runtime config and cloud imports in separate JSON documents", JSON.stringify({ runtimeRow, cloudRow }));
              ctx.output("$ bun runtime-db-primitive-harness.mjs write-runtime-cloud", commandOutput(writeRun));
              ctx.output("$ bun runtime-db-primitive-harness.mjs read-runtime-cloud", commandOutput(readRun));
              ctx.output("SQLite tables", tables.join("\n"));
            },
          });
        } finally {
          await rm(paths.root, { recursive: true, force: true });
        }
      },
    },
    {
      name: "A fresh process can read every domain back",
      run: async (ctx) => {
        const paths = await createHarness();
        try {
          let writeRun: SpawnSyncReturns<string> | null = null;
          let readRun: SpawnSyncReturns<string> | null = null;
          await ctx.prove("After the writer process exits, a new store process reads every domain back from the same DB", {
            voiceover: vo[3],
            action: async () => {
              writeRun = runHarness(paths, "write-all");
              readRun = runHarness(paths, "read-all");
            },
            assert: async () => {
              if (!writeRun || !readRun) throw new Error("durability harness did not run");
              witness(ctx, writeRun.status === 0 && readRun.status === 0, "Writer and fresh reader harnesses exit 0", [commandOutput(writeRun), commandOutput(readRun)].join("\n"));
              const output = parseHarnessJson(readRun);
              const tables = readTableNames(paths.dbPath);
              witness(ctx, output.groupLabel === "Flow group", "Fresh process reads session groups", JSON.stringify(output));
              witness(ctx, output.workspaceLabel === "Flow workspace config", "Fresh process reads workspace config", JSON.stringify(output));
              witness(ctx, output.runtimePlugin === "flow-runtime-plugin", "Fresh process reads runtime OpenCode config", JSON.stringify(output));
              witness(ctx, output.cloudPluginName === "Flow Runtime Plugin", "Fresh process reads cloud plugin install state", JSON.stringify(output));
              witness(ctx, tables.length === 4, "The reopened DB contains exactly the four migrated domain tables", tables.join(", "));
              ctx.output("$ bun runtime-db-primitive-harness.mjs write-all", commandOutput(writeRun));
              ctx.output("$ bun runtime-db-primitive-harness.mjs read-all", commandOutput(readRun));
              ctx.output("runtime.sqlite", paths.dbPath);
            },
          });
        } finally {
          await rm(paths.root, { recursive: true, force: true });
        }
      },
    },
  ],
});
