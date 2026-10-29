import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedOpencodeServer, isolatedOpencodeV1Database } from "../src/managed-opencode.js";
import { opencodeV1DatabasePath } from "../src/opencode-v2-migration.js";

// A standalone OpenCode v2 shares engine v1's default database and global
// config. These tests run a stand-in engine that exits exactly like v1 does on
// each collision and record the storage environment every spawn was handed.

type Mode = "healthy" | "v2-database" | "v2-config" | "v2-both" | "project-config";

type Spawn = { OPENCODE_DB?: string; XDG_CONFIG_HOME?: string };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FAKE_ENGINE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const env = process.env;
appendFileSync(env.FAKE_LOG, JSON.stringify({ OPENCODE_DB: env.OPENCODE_DB, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }) + "\\n");
const mode = env.FAKE_MODE;
const sharedDatabase = !env.OPENCODE_DB;
const sharedConfig = env.XDG_CONFIG_HOME === env.FAKE_SHARED_XDG;
const fail = (text) => { process.stderr.write("Error: Unexpected error\\n\\n" + text + "\\n"); process.exit(1); };
const v2Permissions = (path) => "Configuration is invalid at " + path + "\\n\\u21b3 V2 permissions are not supported by OpenCode V1. Use V1 \\"permission\\" rules or run opencode2. permissions";
if ((mode === "v2-database" || mode === "v2-both") && sharedDatabase) fail("Database is not empty and has no session table");
if ((mode === "v2-config" || mode === "v2-both") && sharedConfig) fail(v2Permissions(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")));
if (mode === "project-config") fail(v2Permissions(join(env.FAKE_PROJECT, "opencode.json")));
process.stdout.write("opencode server listening on http://127.0.0.1:" + env.FAKE_PORT + "\\n");
setInterval(() => {}, 1 << 30);
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function world(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), "openwork-foreign-storage-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  const sharedXdg = join(root, "home", ".config");
  await mkdir(cwd, { recursive: true });
  const bin = join(root, "opencode.cjs");
  await writeFile(bin, FAKE_ENGINE, "utf8");
  await chmod(bin, 0o755);
  const log = join(root, "spawns.jsonl");
  const stateDir = join(root, "state");
  const env: Record<string, string | undefined> = {
    FAKE_LOG: log,
    FAKE_MODE: mode,
    FAKE_PORT: String(await freePort()),
    FAKE_SHARED_XDG: sharedXdg,
    FAKE_PROJECT: join(root, "project"),
    XDG_CONFIG_HOME: sharedXdg,
    OPENCODE_DB: undefined,
  };
  return {
    stateDir,
    start: (options: { stateDir?: string } = { stateDir }) => createManagedOpencodeServer({ bin, cwd, env, ...options }),
    spawns: async (): Promise<Spawn[]> => (await readFile(log, "utf8").catch(() => ""))
      .split("\n").filter(Boolean).map((line): Spawn => JSON.parse(line)),
  };
}

test("a v2 database moves only the database, and history migration follows it", async () => {
  const w = await world("v2-database");
  const server = await w.start();
  try {
    const spawns = await w.spawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.OPENCODE_DB).toBeUndefined();
    const database = join(w.stateDir, "opencode.db");
    expect(spawns[1]).toEqual({ OPENCODE_DB: database, XDG_CONFIG_HOME: spawns[0]?.XDG_CONFIG_HOME });
    expect(isolatedOpencodeV1Database()).toBe(database);
    expect(opencodeV1DatabasePath({ HOME: "/home/example" })).toBe(database);
  } finally {
    await server.close();
  }
});

test("a v2 global config moves only the global config, keeping the shared v1 history", async () => {
  const w = await world("v2-config");
  const server = await w.start();
  try {
    const spawns = await w.spawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual({ XDG_CONFIG_HOME: join(w.stateDir, "xdg-config") });
  } finally {
    await server.close();
  }
});

test("a v2 install owning both moves both, one at a time", async () => {
  const w = await world("v2-both");
  const server = await w.start();
  try {
    const spawns = await w.spawns();
    expect(spawns).toHaveLength(3);
    expect(spawns[2]).toEqual({ OPENCODE_DB: join(w.stateDir, "opencode.db"), XDG_CONFIG_HOME: join(w.stateDir, "xdg-config") });
  } finally {
    await server.close();
  }
});

test("an invalid project config is reported, not moved around", async () => {
  const w = await world("project-config");
  await expect(w.start()).rejects.toThrow(/V2 permissions are not supported/);
  expect(await w.spawns()).toHaveLength(1);
});

test("a working shared store is left alone", async () => {
  const w = await world("healthy");
  const server = await w.start();
  try {
    const spawns = await w.spawns();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.OPENCODE_DB).toBeUndefined();
    expect(server.execution.env.some((entry) => entry.name === "OPENCODE_DB")).toBe(false);
  } finally {
    await server.close();
  }
});

test("without private storage the collision is reported as before", async () => {
  const w = await world("v2-database");
  await expect(w.start({})).rejects.toThrow(/has no session table/);
  expect(await w.spawns()).toHaveLength(1);
});
