import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@openwork/testkit";

// Historical baseline only: this capture predates the async extraction fix.
// It proves attribution on the original logging head (3733c203b0), not a stall
// or packaged-source correspondence on the current merged head. The current
// async path is expected to keep heartbeats running; unit.test.ts checks that.
const BASELINE_ASAR_SHA256 = "b435be088484945739ba0c9acab40a9a25e22c58afe2da509062af8adefded73";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("historical Windows baseline before async extraction retains the original attributed stall evidence", () => {
  const directory = process.env.OPENWORK_STARTUP_LOG_PROOF_DIR;
  assert.ok(directory, "Set OPENWORK_STARTUP_LOG_PROOF_DIR to a captured packaged launch (windows-startup.log, windows-provenance.json, candidate.asar)");
  const provenance = JSON.parse(readFileSync(join(directory, "windows-provenance.json"), "utf8"));
  assert.equal(provenance.platform, "win32");
  assert.equal(provenance.activeRdp, true);
  assert.equal(provenance.isAdmin, false);
  assert.ok(provenance.processes.length > 0);
  assert.ok(provenance.processes.every((entry: { session: number; owner: string }) => entry.session > 0 && entry.owner.startsWith("exp-spl-")));
  const archive = join(directory, "candidate.asar");
  assert.equal(digest(readFileSync(archive)), BASELINE_ASAR_SHA256, "only the pre-async baseline belongs in this historical test");
  assert.equal(provenance.asarSha256.toLowerCase(), BASELINE_ASAR_SHA256);
  const text = readFileSync(join(directory, "windows-startup.log"), "utf8");
  assert.equal(/https?:\/\/|[A-Z]:\\\\Users\\\\|Bearer |token|password|prompt/i.test(text), false);
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  for (const phase of ["app.ready", "window.create", "window.show", "runtime.start", "server.start", "engine.v1.resolve", "engine.version-probe", "engine.v1.serve", "engine.v2.resolve", "engine.v2.version-probe", "engine.v2.serve", "plugin-deps.seed", "plugin-deps.extract", "ca.bundle", "windows.shortcut"]) {
    assert.ok(rows.some((row) => row.event === "start" && row.phase === phase), `${phase} starts`);
    assert.ok(rows.some((row) => row.event === "end" && row.phase === phase && row.durationMs >= 0), `${phase} finishes`);
  }
  const stall = rows.find((row) => row.event === "stall" && row.lateMs > 2000 && row.open.some((entry: { phase: string }) => entry.phase === "plugin-deps.extract"));
  assert.ok(stall, "the historical synchronous extraction was attributed; this is not a current-head stall expectation");
  const extraction = stall.open.find((entry: { phase: string }) => entry.phase === "plugin-deps.extract");
  const endIndex = rows.findIndex((row) => row.event === "end" && row.id === extraction.id);
  assert.ok(endIndex > rows.indexOf(stall), "attribution survives synchronous completion before timer dispatch");
  assert.ok(rows[endIndex].durationMs >= 2000);
  assert.ok(rows.some((row) => row.event === "end" && row.phase === "runtime.start" && row.status === "ok"), "runtime recovered after the stall");
});
