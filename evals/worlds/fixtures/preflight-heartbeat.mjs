// Real production preflight on an isolated Electron main loop, not a busy-loop mock.
import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preflightHistoryCopy } from "../../../apps/server/dist/opencode-v2-migration.js";

const directory = process.argv[2];
if (!directory) throw new Error("A synthetic fixture directory is required");
app.setPath("userData", join(directory, "electron-profile"));
await app.whenReady();
try {
  const storageDir = join(directory, "storage");
  const staging = join(storageDir, "history-copy");
  await mkdir(join(staging, "converted"), { recursive: true });
  const source = join(directory, "synthetic-v1.db");
  const targetDatabase = join(directory, "synthetic-v2.db");
  const original = join(staging, "source.db");
  const converted = join(staging, "converted", "opencode.db");
  const raw = new DatabaseSync(original);
  raw.exec("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT)");
  const insert = raw.prepare("INSERT INTO part VALUES (?, ?)");
  const payload = "synthetic payload ".repeat(Math.ceil(8 * 1024 ** 2 / 18));
  raw.exec("BEGIN");
  for (let i = 0; i < 96; i++) insert.run(`part-${i}`, payload);
  raw.exec("COMMIT");
  raw.close();
  const projection = new DatabaseSync(converted);
  projection.exec("CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE openwork_payload(value TEXT)");
  projection.prepare("INSERT INTO session_message VALUES ('message', 'session', ?)").run('{"text":"projection"}');
  projection.exec("BEGIN");
  for (let i = 0; i < 64; i++) projection.prepare("INSERT INTO openwork_payload VALUES (?)").run(payload);
  projection.exec("COMMIT");
  projection.close();
  await writeFile(source, "synthetic source sentinel");
  const checkpoint = join(staging, "checkpoint.json");
  await writeFile(checkpoint, JSON.stringify({ source, target: targetDatabase, phase: "restoring", sourceKey: "synthetic", snapshotStartedAt: 1 }));
  const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
  const beforeCheckpoint = await digest(checkpoint);
  const beforeSource = await digest(source);
  // Pure expected arithmetic independent of the production estimator.
  const bytes = Buffer.byteLength(payload);
  const needed = 96 * bytes + Buffer.byteLength('{"text":"projection"}') + 64 * (bytes + 2) * 2;
  const expected = `Not enough free disk space to upgrade safely. Free up about ${Math.ceil(((needed + 1024 ** 3) / 1024 ** 3) * 10) / 10} GB and try again. Nothing was changed.`;
  let previous = performance.now();
  let maxLag = 0;
  let stalls = 0;
  let ticks = 0;
  const sample = () => {
    const now = performance.now();
    const lag = Math.max(0, now - previous - 10);
    previous = now; maxLag = Math.max(maxLag, lag); ticks++;
    if (lag >= 250) stalls++;
  };
  const timer = setInterval(sample, 10);
  const started = performance.now();
  let refusal;
  try { await preflightHistoryCopy({ source, storageDir, targetDatabase, freeBytes: async () => 0 }); }
  catch (error) { refusal = error.message; }
  // Include the final synchronous span even if the promise resolves before a tick.
  sample(); clearInterval(timer);
  const result = { maxLag, stalls, ticks, elapsedMs: performance.now() - started, refusal, expected,
    unchanged: beforeCheckpoint === await digest(checkpoint) && beforeSource === await digest(source),
    targetAbsent: await readFile(targetDatabase).then(() => false, error => error.code === "ENOENT"),
    electronMain: process.type === "browser", electron: process.versions.electron };
  console.log(`PREFLIGHT_RESULT ${JSON.stringify(result)}`);
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
