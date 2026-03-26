import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { resolveOpencodeDbPath, seedOpencodeSessionMessages } from "./opencode-db.js";

async function createDb(): Promise<{ path: string; dispose: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-opencode-db-"));
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "opencode-test.db");
  const db = new Database(dbPath);
  db.exec(`
    create table session (
      id text primary key,
      time_updated integer
    );
    create table message (
      id text primary key,
      session_id text not null,
      time_created integer,
      time_updated integer,
      data text not null
    );
    create table part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer,
      time_updated integer,
      data text not null
    );
    insert into session (id, time_updated) values ('ses_test123', 1);
  `);
  db.close();
  return {
    path: dbPath,
    dispose: () => new Database(dbPath).close(),
  };
}

describe("seedOpencodeSessionMessages", () => {
  test("writes seeded transcript messages into the OpenCode db", async () => {
    const fixture = await createDb();
    const result = seedOpencodeSessionMessages({
      dbPath: fixture.path,
      sessionId: "ses_test123",
      workspaceRoot: "/tmp/workspace",
      now: 1700000000000,
      messages: [
        { role: "assistant", text: "Welcome" },
        { role: "user", text: "Help me start" },
        { role: "assistant", text: "Sure" },
      ],
    });

    expect(result).toEqual({ inserted: 3, skipped: false });

    const db = new Database(fixture.path, { readonly: true });
    const rows = db.query("select id, session_id, data from message order by time_created asc").all() as Array<{
      id: string;
      session_id: string;
      data: string;
    }>;
    const parts = db.query("select data from part order by time_created asc").all() as Array<{ data: string }>;
    const session = db.query("select time_updated from session where id = 'ses_test123'").get() as { time_updated: number };
    db.close();

    const decoded = rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
    expect(decoded[0]?.role).toBe("assistant");
    expect(decoded[0]?.parentID).toBe(rows[0]?.id);
    expect(decoded[0]?.modelID).toBe("gpt-5.4");
    expect(decoded[0]?.providerID).toBe("openai");
    expect(decoded[1]?.role).toBe("user");
    expect(decoded[1]?.summary).toEqual({ diffs: [] });
    expect(decoded[2]?.role).toBe("assistant");
    expect(decoded[2]?.parentID).toBe(rows[1]?.id);
    expect(parts.map((row) => JSON.parse(row.data))).toEqual([
      { type: "text", text: "Welcome" },
      { type: "text", text: "Help me start" },
      { type: "text", text: "Sure" },
    ]);
    expect(session.time_updated).toBe(1700000000003);
  });

  test("does not seed a session twice", async () => {
    const fixture = await createDb();
    const first = seedOpencodeSessionMessages({
      dbPath: fixture.path,
      sessionId: "ses_test123",
      workspaceRoot: "/tmp/workspace",
      messages: [{ role: "assistant", text: "Welcome" }],
    });
    const second = seedOpencodeSessionMessages({
      dbPath: fixture.path,
      sessionId: "ses_test123",
      workspaceRoot: "/tmp/workspace",
      messages: [{ role: "assistant", text: "Welcome again" }],
    });

    expect(first.skipped).toBe(false);
    expect(second).toEqual({ inserted: 0, skipped: true });
  });
});

describe("resolveOpencodeDbPath", () => {
  test("prefers an existing XDG opencode.db when present", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "openwork-opencode-xdg-"));
    const dir = join(xdg, "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.XDG_DATA_HOME = xdg;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveOpencodeDbPath()).toBe(file);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });

  test("finds orchestrator-managed OpenCode dbs under OPENWORK_DATA_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-orchestrator-data-"));
    const dir = join(root, "openwork-dev-data", "xdg", "data", "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousDataDir = process.env.OPENWORK_DATA_DIR;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.OPENWORK_DATA_DIR = root;
      delete process.env.XDG_DATA_HOME;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveOpencodeDbPath()).toBe(file);
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
      else process.env.OPENWORK_DATA_DIR = previousDataDir;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });

  test("finds legacy orchestrator-managed OpenCode dbs under OPENWORK_DATA_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-orchestrator-data-"));
    const dir = join(root, "opencode-dev", "ws-test", "xdg", "data", "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousDataDir = process.env.OPENWORK_DATA_DIR;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.OPENWORK_DATA_DIR = root;
      delete process.env.XDG_DATA_HOME;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveOpencodeDbPath()).toBe(file);
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
      else process.env.OPENWORK_DATA_DIR = previousDataDir;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });
});
