import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finalizePreviewHandoffs } from "../../packages/daytona-evidence/src/handoff.ts";
import { readTestRunFile } from "../packages/test-artifacts/src/scan.ts";
import { verifyCorePreviewRestore } from "./verify-core-preview-restore.ts";
import { annotateCorePreview } from "./core-preview-record.ts";

const owner = process.env.OPENWORK_DAYTONA_PREVIEW_OWNER ?? "";
const sourceSha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA ?? "";
const cleanupOnly = process.env.OPENWORK_PREVIEW_CLEANUP_ONLY === "1";
const started = Date.now();
let previews: Awaited<ReturnType<typeof finalizePreviewHandoffs>> = [];
let failure: unknown;
try {
  previews = await finalizePreviewHandoffs({ owner, sourceSha }, undefined, { cleanupOnly });
  for (const preview of previews) {
    if (!preview.ready) continue;
    const restoreStarted = Date.now();
    await verifyCorePreviewRestore(preview.checkpoint);
    console.log(JSON.stringify({ stage: "core-preview-restore-after-source-teardown", ms: Date.now() - restoreStarted, verified: true }));
  }
} catch (error) {
  failure = error;
  previews = previews.map(preview => ({ ...preview, ready: false }));
}
if (!cleanupOnly) {
  const root = "evals/results/test-runs";
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "test-run.json");
    const record = await readTestRunFile(path);
    if (!record) throw new Error("Invalid Core preview record");
    annotateCorePreview(record, sourceSha, previews);
    if (record.outcome === "passed" && !record.artifacts.some(artifact => artifact.checkpoint?.provider === "daytona")) {
      failure ??= new Error("Core assertions passed, but its optional final preview was not captured, saved and restored");
    }
    // Assertion outcome, summaries, trace and CLI verdict are never changed.
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }
}
console.log(JSON.stringify({ stage: "core-preview-finalizer", ms: Date.now() - started, saved: previews.filter(p => p.ready).length, cleanupOnly, failed: Boolean(failure) }));
if (failure) throw failure;
