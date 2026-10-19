import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SkipError, type Place, type Seed } from "@openwork/env";

/**
 * A computer that still has chats from OpenCode v1, the engine OpenWork used
 * before v2, in an isolated database file the desktop's local server reads
 * once to bring them over. The same database is written on every run: fixed
 * ids, fixed timestamps, the real v1.18.30 schema
 * (fixtures/opencode-v1-history/schema.sql) and four made-up chats, one of
 * them a sub-chat, so a parent must be copied before its child.
 */

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v1-history", "schema.sql");
const BASE_TIME = Date.UTC(2026, 0, 5, 9, 0, 0);
const MODEL = { providerID: "fixture", modelID: "fixture-model" };

export interface V1FixtureChat {
  id: string;
  parentId: string | null;
  title: string;
  prompt: string;
  reply: string;
  /** A file the assistant read, as a completed tool step. */
  readFile?: string;
}

function fixtureId(prefix: "ses" | "msg" | "prt", n: number): string {
  // Same shape as engine ids (prefix, 12 hex digits, 14 characters), ascending.
  return `${prefix}_${n.toString(16).padStart(12, "0")}FixtureHistory`;
}

export const V1_FIXTURE_CHATS: readonly V1FixtureChat[] = [
  {
    id: fixtureId("ses", 1), parentId: null, title: "Summarize the quarterly budget",
    prompt: "Summarize budget.md in three bullet points.",
    reply: "Spending is 4% under plan, travel is the largest overrun, and hiring moved to Q3.",
    readFile: "budget.md",
  },
  {
    id: fixtureId("ses", 2), parentId: fixtureId("ses", 1), title: "Find last year's travel total (sub-chat)",
    prompt: "Find last year's travel total.",
    reply: "Last year's travel total was $182,400.",
  },
  {
    id: fixtureId("ses", 3), parentId: null, title: "Draft the launch email",
    prompt: "Draft a short launch email for the new release.",
    reply: "Subject: The new release is here. It is faster, works offline, and keeps your chats safe.",
  },
  {
    id: fixtureId("ses", 4), parentId: null, title: "Clean up the meeting notes",
    prompt: "Turn these meeting notes into action items.",
    reply: "Action items: send the agenda, book the room, and share the budget summary.",
  },
];

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Write the fixture history for `directory` (the workspace the chats belong to). Overwrites `database`. */
export async function writeV1FixtureHistory(database: string, directory: string): Promise<{ chats: number }> {
  await mkdir(dirname(database), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${database}${suffix}`, { force: true });
  const db = new DatabaseSync(database);
  try {
    db.exec(await readFile(SCHEMA, "utf8"));
    db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', ?, ?, '[]')")
      .run(BASE_TIME, BASE_TIME);
    const session = db.prepare(`INSERT INTO session
      (id, project_id, parent_id, slug, directory, title, version, agent, model, time_created, time_updated)
      VALUES (?, 'global', ?, ?, ?, ?, '1.18.30', 'build', ?, ?, ?)`);
    const message = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)");
    let messageN = 0;
    let partN = 0;
    V1_FIXTURE_CHATS.forEach((chat, index) => {
      const start = BASE_TIME + index * 3_600_000;
      const end = start + 6_000;
      session.run(chat.id, chat.parentId, `fixture-chat-${index + 1}`, directory, chat.title,
        json({ id: MODEL.modelID, providerID: MODEL.providerID, variant: "default" }), start, end);
      const userId = fixtureId("msg", ++messageN);
      message.run(userId, chat.id, start, start, json({
        role: "user", time: { created: start }, agent: "build", model: MODEL, summary: { diffs: [] },
      }));
      part.run(fixtureId("prt", ++partN), userId, chat.id, start, start, json({ type: "text", text: chat.prompt }));
      const assistantId = fixtureId("msg", ++messageN);
      const tokens = { input: 120, output: 40, reasoning: 0, cache: { read: 0, write: 0 } };
      message.run(assistantId, chat.id, start + 1_000, end, json({
        parentID: userId, role: "assistant", mode: "build", agent: "build",
        path: { cwd: directory, root: directory }, cost: 0, tokens,
        modelID: MODEL.modelID, providerID: MODEL.providerID,
        time: { created: start + 1_000, completed: end }, finish: "stop",
      }));
      part.run(fixtureId("prt", ++partN), assistantId, chat.id, start + 1_000, start + 1_000, json({ type: "step-start" }));
      if (chat.readFile) {
        part.run(fixtureId("prt", ++partN), assistantId, chat.id, start + 2_000, start + 3_000, json({
          type: "tool", tool: "read", callID: `call_fixture_${index + 1}`,
          state: {
            status: "completed", input: { filePath: join(directory, chat.readFile) },
            output: "Plan: $1.20M. Actual: $1.15M. Travel: +18%. Hiring: moved to Q3.",
            metadata: {}, title: chat.readFile, time: { start: start + 2_000, end: start + 3_000 },
          },
        }));
      }
      part.run(fixtureId("prt", ++partN), assistantId, chat.id, start + 4_000, end, json({
        type: "text", text: chat.reply, time: { start: start + 4_000, end },
      }));
      part.run(fixtureId("prt", ++partN), assistantId, chat.id, end, end, json({
        type: "step-finish", reason: "stop", tokens: { total: 160, ...tokens }, cost: 0,
      }));
    });
  } finally {
    db.close();
  }
  return { chats: V1_FIXTURE_CHATS.length };
}

/**
 * The chats in a v1 database as content: sessions, messages and parts with
 * their stored data, hashed. Equal before and after the import means the v1
 * history was only read.
 */
export function readV1HistoryDigest(database: string): { sessions: number; messages: number; parts: number; sha256: string } {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const hash = createHash("sha256");
    const counts = [0, 0, 0];
    const queries = [
      "SELECT id, parent_id, directory, title, time_created FROM session ORDER BY id",
      "SELECT id, session_id, data FROM message ORDER BY id",
      "SELECT id, message_id, session_id, data FROM part ORDER BY id",
    ];
    queries.forEach((query, index) => {
      hash.update(`\u0000table${index}`);
      for (const row of db.prepare(query).iterate()) {
        hash.update(JSON.stringify(row));
        counts[index]!++;
      }
    });
    return { sessions: counts[0]!, messages: counts[1]!, parts: counts[2]!, sha256: hash.digest("hex") };
  } finally {
    db.close();
  }
}

/**
 * A desktop (OpenCode v2, the only engine) whose local server finds the
 * fixture v1 history through `OPENCODE_DB`, the override its v1-history
 * reader checks before `$XDG_DATA_HOME/opencode/opencode.db`. The v2 engine
 * keeps its own database, so nothing has been brought over yet.
 */
export async function v1ChatHistory(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the seeded v1 history is a file the local desktop opens directly");
  const workspaceDir = seed.tmpPath("v1-chat-history-workspace");
  await mkdir(workspaceDir, { recursive: true });
  // Engines store the resolved folder (/private/tmp on macOS, not /tmp); chats
  // written under any other spelling would not belong to the workspace.
  const workspacePath = await realpath(workspaceDir);
  const database = join(seed.tmpPath("v1-chat-history-data"), "opencode", "opencode.db");
  const seeded = await writeV1FixtureHistory(database, workspacePath);
  const before = readV1HistoryDigest(database);
  const app = await seed.desktop({ name: "v1-chat-history", env: { OPENCODE_DB: database } });
  const workspace = await seed.workspace(app, workspacePath);
  return {
    app, workspace, workspacePath,
    expectedChats: seeded.chats,
    before,
    chats: V1_FIXTURE_CHATS,
    readV1History: () => readV1HistoryDigest(database),
  };
}
