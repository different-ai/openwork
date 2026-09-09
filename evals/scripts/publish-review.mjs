import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReviewPr } from "../packages/test-artifacts/src/publish-pr.ts";
import { readTestRunDirectory } from "../packages/test-artifacts/src/scan.ts";

const { REVIEW_PR: pr, REVIEW_SHA: sha, REVIEW_RUN_ID: runId } = process.env;
if (
  !pr ||
  !/^\d+$/.test(pr) ||
  !runId ||
  !/^\d+$/.test(runId) ||
  !sha ||
  !/^[a-f0-9]{40}$/.test(sha)
)
  throw new Error("Missing CI report identity.");
const current = spawnSync(
  "gh",
  ["pr", "view", pr, "--json", "headRefOid", "--jq", ".headRefOid"],
  { encoding: "utf8", timeout: 30_000 },
);
if (current.status !== 0) throw new Error("Cannot resolve PR head.");
if (current.stdout.trim() !== sha) {
  console.log(
    "Source run is no longer current; existing evidence is unchanged.",
  );
} else {
  const directory = await mkdtemp(join(tmpdir(), "openwork-review-"));
  try {
    const download = spawnSync(
      "gh",
      ["run", "download", runId, "--dir", directory],
      { stdio: "inherit", timeout: 90_000 },
    );
    if (download.status !== 0)
      throw new Error("Unable to download completed evidence.");
    const testRunDirs = [];
    async function visit(path, depth = 0) {
      if (depth > 12)
        throw new Error("Evidence directory nesting exceeds the limit.");
      const entries = await readdir(path, { withFileTypes: true });
      if (
        entries.some(
          (entry) => entry.isFile() && entry.name === "test-run.json",
        )
      ) {
        const stored = await readTestRunDirectory(path);
        if (!stored) throw new Error("Malformed recorded evidence.");
        if (stored.testRun.gitSha === sha) testRunDirs.push(path);
      }
      for (const entry of entries)
        if (entry.isDirectory()) await visit(join(path, entry.name), depth + 1);
    }
    await visit(directory);
    if (testRunDirs.length === 0) {
      console.log(
        "No test records for this PR head were uploaded by the source workflow.",
      );
    } else {
      const result = await publishReviewPr({ pr, testRunDirs, preserveCurrentReport: true });
      console.log(result.posted ? result.urls.report : "A review already covers this commit; preserving the author's selection.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
