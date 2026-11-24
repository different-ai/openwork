import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import {
  cleanBaseAuditScript, pagedSnapshotListExec, parseCleanBaseAudit, parseProvisionSteps, percentile, settledPool,
  stopWorkshopAppsScript, workshopSnapshotName,
} from "./workshop-snapshot.ts";

const SHA = "ef0db73ae009b6904d13bb8b1f5a391db713d86c";

test("snapshot names carry the short SHA and UTC day, and refuse moving refs", () => {
  assert.equal(workshopSnapshotName(SHA, new Date("2026-10-21T03:40:00Z")), "workshop-desktop-ef0db73-20261021");
  assert.equal(workshopSnapshotName(SHA, new Date("2026-10-21T03:40:00Z"), "b2"), "workshop-desktop-ef0db73-20261021-b2");
  assert.throws(() => workshopSnapshotName("dev", new Date()));
  assert.throws(() => workshopSnapshotName(SHA, new Date(), "Bad Suffix"));
});

test("the audit passes only on an explicit AUDIT_OK with no findings", () => {
  assert.deepEqual(parseCleanBaseAudit("AUDIT_OK\n"), { ok: true, findings: [] });
  assert.deepEqual(parseCleanBaseAudit("FINDING credential-file:/home/daytona/.local/share/opencode/auth.json\n"),
    { ok: false, findings: ["credential-file:/home/daytona/.local/share/opencode/auth.json"] });
  assert.equal(parseCleanBaseAudit("").ok, false, "an empty or truncated audit is not clean");
});

test("remote scripts are transport-safe and never print secret values", () => {
  for (const script of [cleanBaseAuditScript(), stopWorkshopAppsScript()]) {
    assert.ok(!script.includes("'"), "scripts travel as base64 but must stay single-quote free for execInSandbox callers");
  }
  const audit = cleanBaseAuditScript();
  assert.match(audit, /cut -d= -f1/, "environment checks report variable names only");
  assert.match(audit, /grep -rIlE/, "content checks list file paths only");
  assert.match(audit, /Cookies/);
  assert.match(audit, /\/daytona-secrets/);
});

test("provision gate timings are read from the primitive's own log lines", () => {
  assert.deepEqual(parseProvisionSteps(["==> sandbox gate...", "==> sandbox gate done (12345ms)", "==> first boot gate failed (900ms)", "noise"]),
    { "sandbox gate": 12.3, "first boot gate": 0.9 });
});

test("snapshot listing is served from every page; other calls pass through", async () => {
  const calls: string[][] = [];
  const pages = [Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, name: `s${i}` })), [{ id: "new", name: "workshop-desktop-x" }]];
  const inner: DaytonaExec = async (args) => {
    calls.push(args);
    if (args[0] === "snapshot") return { code: 0, stderr: "", stdout: JSON.stringify(pages[Number(args[5]) - 1] ?? []) };
    return { code: 0, stderr: "", stdout: "passthrough" };
  };
  const exec = pagedSnapshotListExec(inner);
  const listed: unknown = JSON.parse((await exec(["snapshot", "list", "-f", "json"])).stdout);
  assert.ok(Array.isArray(listed));
  assert.equal(listed.length, 101);
  assert.equal((await exec(["info", "x", "-f", "json"])).stdout, "passthrough");
  assert.deepEqual(calls.map((args) => args.join(" ")), [
    "snapshot list -f json --page 1 --limit 100", "snapshot list -f json --page 2 --limit 100", "info x -f json",
  ]);
});

test("the pool bounds concurrency, keeps order and settles every item", async () => {
  let active = 0, peak = 0;
  const results = await settledPool([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (value === 4) throw new Error("boom");
    return value * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results.map((result) => result.status === "fulfilled" ? result.value : "failed"), [10, 20, 30, "failed", 50, 60, 70]);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 100), 5);
  assert.equal(percentile([], 50), null);
});
