import { cleanupDaytonaEvidence } from "../packages/evidence-daytona/src/cleanup.ts";

// Reclaims Daytona evidence snapshots and sandboxes; see packages/evidence-daytona/src/cleanup.ts.
const dryRun = process.argv.includes("--dry-run");
const result = await cleanupDaytonaEvidence(undefined, { dryRun });
console.log(JSON.stringify({ dryRun, ...result }, null, 2));
