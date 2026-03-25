import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { seedOpencodeSessionMessages } from "./opencode-db.js";

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
    expect(decoded[1]?.role).toBe("user");
    expect(decoded[2]?.role).toBe("assistant");
    expect(decoded[2]?.parentID).toBe(rows[1]?.id);
    expect(parts.map((row) => JSON.parse(row.data).text)).toEqual(["Welcome", "Help me start", "Sure"]);
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
