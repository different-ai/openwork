import { ensureEvidenceSnapshot } from "../packages/freestyle/src/evidence-builder.ts";

// Builds (or finds) this commit's e2e/preview world in Freestyle.
// OPENWORK_EVIDENCE_IMAGE_SHA pins the dev commit to start from; the dev warm-up
// passes its own commit so dev's image and world are both ready for PRs.
const sha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA;
const imageSha = process.env.OPENWORK_EVIDENCE_IMAGE_SHA || undefined;
if (!sha || !process.env.FREESTYLE_API_KEY?.trim()) throw new Error("OPENWORK_EVIDENCE_SOURCE_SHA and FREESTYLE_API_KEY are required");
const started = performance.now();
const stages: { stage: string; durationMs: number; cacheHit?: boolean; reason?: string }[] = [];
try {
  await ensureEvidenceSnapshot(sha, undefined, {
    imageSha,
    observe: (event) => { stages.push(event); console.log(JSON.stringify(event)); },
    // The builder VM is credential-free and built from this public commit; its
    // log tail is the fastest way to see why the shared e2e/preview world failed.
    diagnostic: async (stage, log) => {
      console.log(`::group::${stage} builder log (last 80 lines)`);
      console.log(log.split("\n").slice(-80).join("\n"));
      console.log("::endgroup::");
    },
  });
  console.log(`Freestyle world ready for ${sha} in ${Math.round((performance.now() - started) / 1000)}s`);
} catch (error) {
  console.error(`::error::Freestyle world preparation failed: ${error instanceof Error ? error.message : String(error)}. See the builder log group above.`);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    const path = stages.find((stage) => stage.stage.startsWith("path:"));
    const rows = stages.filter((stage) => stage.cacheHit !== undefined && !stage.stage.startsWith("path:"))
      .map((stage) => `| ${stage.stage} | ${stage.cacheHit ? "reused" : "built"} | ${Math.round(stage.durationMs / 1000)}s |`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Freestyle world\n\n${path ? `**${path.stage.slice(6)}** (${path.reason})\n\n` : ""}| Layer | Result | Time |\n| --- | --- | --- |\n${rows.join("\n")}\n`);
  }
}
