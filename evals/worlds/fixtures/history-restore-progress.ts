// Bun fixture builder/counter for the real migration-progress desktop proof.
// All history is synthetic and all database paths are supplied by the testkit.
import { mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { attachHistory, externalizeHistory, openHistoryDatabase } from "../../../apps/server/src/opencode-v2-history-store.ts";
import { snapshotV1Database } from "../../../apps/server/src/opencode-v2-migration.ts";
import { createManagedOpencodeV2Server } from "../../../apps/server/src/managed-opencode-v2.ts";

const [root, workspace, bin, command] = process.argv.slice(2);
const stage = join(root, "history-copy");
const convertedDir = join(stage, "converted");
const converted = join(convertedDir, "opencode.db");
if (command === "count") {
  const db = await openHistoryDatabase(":memory:");
  attachHistory(db, converted, "fixture");
  db.exec("PRAGMA busy_timeout = 2000");
  try { console.log(JSON.stringify({ done: db.prepare("SELECT count(*) AS n FROM fixture.openwork_restored").get(), total: db.prepare("SELECT count(*) AS n FROM fixture.session_message").get() })); }
  finally { db.close(); }
} else if (["watch", "advance", "resume"].includes(command)) {
  const exec = promisify(execFile);
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const receipt = join(root, "restore-owner.json");
  const counters = async () => {
    const db = await openHistoryDatabase(":memory:");
    try {
      attachHistory(db, converted, "fixture");
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db.prepare("SELECT count(*) AS n FROM fixture.openwork_restored").get();
      return typeof row === "object" && row !== null && "n" in row && typeof row.n === "number" ? row.n : 0;
    } finally { db.close(); }
  };
  const owners = async () => {
    const pids: number[] = [];
    if (process.platform === "darwin") {
      const { stdout } = await exec("/usr/sbin/lsof", ["-t", converted]).catch(() => ({ stdout: "" }));
      for (const value of new Set(stdout.trim().split(/\s+/))) {
        const pid = Number(value);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        const { stdout: line } = await exec("/bin/ps", ["-p", String(pid), "-o", "command="]).catch(() => ({ stdout: "" }));
        if (line.includes(repo) && line.includes("opencode-v2-migration-process.js")) pids.push(pid);
      }
      return pids;
    }
    if (process.platform !== "linux") throw new Error("The restore-progress fixture needs POSIX process signals");
    // CI's Linux image has procfs, but need not have lsof. Read commands only
    // (never process environments), then inspect FD links ONLY for this
    // checkout's migration-worker candidates. Both gates must match our exact
    // disposable database before a process can be signalled.
    const expected = await realpath(converted);
    const { stdout } = await exec("ps", ["-eo", "pid=,args="]);
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !match[2].includes(repo) || !match[2].includes("opencode-v2-migration-process.js")) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const directory = `/proc/${pid}/fd`;
      const descriptors = await readdir(directory).catch(() => []);
      for (const descriptor of descriptors) {
        const target = await readlink(join(directory, descriptor)).catch(() => "");
        if (target === expected) { pids.push(pid); break; }
      }
    }
    return pids;
  };
  const signalOwner = async (pid: number, signal: NodeJS.Signals) => {
    if (!(await owners()).includes(pid)) throw new Error("Synthetic restore worker ownership could not be verified");
    process.kill(pid, signal);
  };
  if (command === "watch") {
    const deadline = Date.now() + 180_000;
    while (true) {
      const done = await Promise.resolve().then(counters).catch(() => 0);
      const pids = done >= 1000 ? await owners() : [];
      if (pids.length === 1) {
        await signalOwner(pids[0], "SIGSTOP");
        await writeFile(receipt, JSON.stringify({ pid: pids[0], done: await counters() }));
        console.log(JSON.stringify({ paused: true, done }));
        break;
      }
      if (Date.now() > deadline) throw new Error("Synthetic restoration did not reach its screenshot pause");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } else {
    const value: unknown = JSON.parse(await readFile(receipt, "utf8"));
    if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "number") throw new Error("Invalid synthetic owner receipt");
    const before = await counters();
    await signalOwner(value.pid, "SIGCONT");
    if (command === "advance") {
      const deadline = Date.now() + 180_000;
      while (await counters() < before + 10000) {
        if (Date.now() > deadline) throw new Error("Synthetic restoration did not advance");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await signalOwner(value.pid, "SIGSTOP");
      console.log(JSON.stringify({ before, after: await counters() }));
    }
  }
} else {
  await mkdir(convertedDir, { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  // Native config discovery must stay in this disposable fixture, not install
  // workspace plugins or update a developer checkout's package lock.
  process.chdir(root);
  const source = join(root, "v1.db");
  const original = join(stage, "source.db");
  const db = await openHistoryDatabase(source);
  try {
    db.exec(await readFile(new URL("./opencode-v1-history/schema.sql", import.meta.url), "utf8"));
    db.exec("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 1, 1, '[]')");
    db.exec("BEGIN");
    for (let n = 1; n <= 250; n++) {
      db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (?, 'global', ?, ?, ?, '1.18.30', 1, 1)`)
        .run(`ses_${String(n).padStart(26, "0")}`, `history-${n}`, workspace, `Example conversation ${n}`);
    }
    db.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200000)
      SELECT printf('msg_%026d',x),printf('ses_%026d',1+(x-1)%250),x,x,
        json_object('role','user','time',json_object('created',x),'agent','build','model',json_object('providerID','test','modelID','test')) FROM n;
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      SELECT replace(id,'msg_','prt_'),id,session_id,time_created,time_updated,
        json_object('type','text','text',CASE WHEN time_created<=1000 THEN replace(hex(zeroblob(3000)),'00','example ') ELSE 'Example imported message' END) FROM message;
      COMMIT`);
  } finally { db.close(); }
  await snapshotV1Database(source, original);
  await snapshotV1Database(original, converted);
  const staged = await openHistoryDatabase(converted);
  try { attachHistory(staged, original, "original"); await externalizeHistory(staged); }
  finally { staged.close(); }
  const home = join(root, "converter-home");
  await mkdir(home, { recursive: true });
  const isolated = { HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1" };
  const engine = await createManagedOpencodeV2Server({ bin, rootDir: convertedDir, env: isolated });
  try {
    const deadline = Date.now() + 240_000;
    while (true) {
      const result = await engine.fetchJson("/api/experimental/migration/v1");
      if (typeof result.json === "object" && result.json !== null && "status" in result.json) {
        if (result.json.status === "completed") break;
        if (result.json.status === "error") throw new Error("Synthetic native conversion failed");
      }
      if (Date.now() > deadline) throw new Error("Synthetic native conversion did not finish");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally { await engine.close(); }
  const target = join(root, "state", "opencode.db");
  const targetEngine = await createManagedOpencodeV2Server({ bin, rootDir: join(root, "state"), env: isolated });
  await targetEngine.close();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(original)) hash.update(chunk);
  await writeFile(join(stage, "checkpoint.json"), JSON.stringify({ source, target, phase: "restoring", sourceKey: hash.digest("hex"), snapshotStartedAt: Date.now() }));
  await writeFile(join(root, "state", "history-copy.pending"), "Synthetic history copy must finish before engine startup.\n");
  console.log(JSON.stringify({ sessions: 250, sourceMessages: 200000 }));
}
