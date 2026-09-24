import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assembleReview } from "../evals/packages/test-artifacts/src/review.ts";
import { readTestRunDirectory } from "../evals/packages/test-artifacts/src/scan.ts";
import { uploadReview } from "../packages/review/src/storage.ts";

const root = "evals/results/test-runs";
const paths: string[] = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(root, entry.name);
  const record = await readTestRunDirectory(path);
  if (record?.testRun.specFile === "evals/specs/web-checkpoint-fork.e2e.test.ts" || record?.testRun.specFile === "specs/web-checkpoint-fork.e2e.test.ts") paths.push(path);
}
if (!paths.length) throw new Error("No checkpoint journey evidence was produced");
const { report, assets } = await assembleReview({ testRunDirs: paths, title: "Enter a saved web checkpoint" });
if (report.gitSha !== process.env.OPENWORK_EVIDENCE_SOURCE_SHA) throw new Error("Evidence does not match this branch head");
const id = await uploadReview(report, assets);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `report_id=${id}\n`);
console.log(`Checkpoint report stored: ${id}`);
