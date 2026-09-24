import { mkdir, writeFile } from "node:fs/promises";
import { client } from "../packages/freestyle/src/index.ts";
import { runCheckpointProbe, type ProbeReport } from "../packages/freestyle/src/checkpoint-probe.ts";

const report: ProbeReport = {
  schemaVersion: 1, scope: "synthetic-vm-memory-and-loopback-stream",
  sourceSha: process.env.CHECKPOINT_SOURCE_SHA ?? "", status: "incomplete",
  stage: "configuration", forkReadyMs: [], checks: [], cleanup: "pending",
};
try {
  await runCheckpointProbe(client(), report);
} catch {
  // Provider errors can embed credentials/URLs. Publish only the bounded stage.
  report.status = "failed";
  console.error(`Checkpoint prerequisite failed at ${report.stage}; no OpenWork/UI verdict is claimed.`);
  process.exitCode = 1;
} finally {
  await mkdir("results/checkpoint-probe", { recursive: true });
  await writeFile("results/checkpoint-probe/report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
