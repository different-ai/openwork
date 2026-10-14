import { execFileSync } from "node:child_process";
import { DaytonaApi } from "../packages/daytona-evidence/src/api.ts";
import { finalizePreviewHandoffs, OWNER_LABEL } from "../packages/daytona-evidence/src/handoff.ts";
import { EVIDENCE_KIND } from "../packages/daytona-evidence/src/kinds.ts";

// Trusted default-branch code only. Never executes producer code or downloads its artifacts.
const api = new DaytonaApi();
const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repository required");
const sources = await api.listSandboxes({ kind: EVIDENCE_KIND });
const seen = new Set<string>();
for (const source of sources) {
  const owner = source.labels[OWNER_LABEL];
  const match = owner && /^(\d+)-(\d+)-core$/.exec(owner);
  if (!match || seen.has(owner)) continue;
  if (process.env.RECOVERY_RUN_ID && match[1] !== process.env.RECOVERY_RUN_ID) continue;
  const run: unknown = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/actions/runs/${match[1]}`], { encoding: "utf8" }));
  if (typeof run !== "object" || run === null || !("status" in run) || run.status !== "completed"
    || !("path" in run) || run.path !== ".github/workflows/pr-proof.yml" || !("event" in run) || run.event !== "pull_request"
    || !("head_sha" in run) || run.head_sha !== source.labels.sourceSha
    || !("run_attempt" in run) || typeof run.run_attempt !== "number" || run.run_attempt < Number(match[2])) continue;
  seen.add(owner);
  await finalizePreviewHandoffs({ owner, sourceSha: source.labels.sourceSha }, api, { cleanupOnly: true });
  console.log(JSON.stringify({ stage: "core-preview-recovery", owner, cleaned: true }));
}
