import { appendFile } from "node:fs/promises";
import { client } from "../packages/freestyle/src/index.ts";
import { deleteSnapshots, isOurs, listAllSnapshots, planCleanup, snapshotsInUse } from "../packages/freestyle/src/cleanup.ts";

// Usage: FREESTYLE_API_KEY=... node scripts/cleanup-freestyle.ts [--dry-run]
const dryRun = process.argv.includes("--dry-run");
// Our snapshots left after cleanup above this count fail the job, so a new leak is visible.
const alertAt = Number(process.env.FREESTYLE_SNAPSHOT_ALERT ?? 600);

const api = client();
const [snapshots, inUse] = await Promise.all([listAllSnapshots(api), snapshotsInUse(api)]);
const plan = planCleanup(snapshots, { now: Date.now(), inUse });
const byReason = new Map<string, number>();
for (const item of plan) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);

const result = dryRun ? { deleted: 0, failed: [] } : await deleteSnapshots(api, plan);
const ours = snapshots.filter((snapshot) => isOurs(snapshot.slug)).length;
const remaining = ours - result.deleted;
const lines = [
  `## Freestyle cleanup${dryRun ? " (dry run)" : ""}`,
  "",
  `Snapshots on the team: ${snapshots.length} (${ours} created by OpenWork CI or the review app)`,
  `Planned deletions: ${plan.length}`,
  ...[...byReason].map(([reason, count]) => `- ${reason}: ${count}`),
  `Deleted: ${result.deleted}, failed: ${result.failed.length}`,
  `Remaining OpenWork snapshots: ${dryRun ? ours - plan.length : remaining} (alert above ${alertAt})`,
];
console.log(lines.join("\n"));
for (const failure of result.failed.slice(0, 20)) console.error(`Failed ${failure.item.slug}: ${failure.reason}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);

if (result.failed.length) process.exitCode = 1;
if ((dryRun ? ours - plan.length : remaining) > alertAt) {
  console.error(`OpenWork keeps more than ${alertAt} Freestyle snapshots after cleanup. Something is creating them faster than they expire.`);
  process.exitCode = 1;
}
