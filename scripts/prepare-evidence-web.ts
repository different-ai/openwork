import { evidenceProviderFromEnv, EVIDENCE_PROVIDER_LABELS } from "../packages/evidence-provider/src/provider.ts";

// Builds (or finds) this commit's e2e/preview world on the provider chosen by
// OPENWORK_EVIDENCE_PROVIDER (unset means Freestyle).
// OPENWORK_EVIDENCE_IMAGE_SHA pins the dev commit to start from; the dev warm-up
// passes its own commit so dev's image and world are both ready for PRs.
const provider = evidenceProviderFromEnv();
const label = EVIDENCE_PROVIDER_LABELS[provider];
const credential = provider === "freestyle" ? "FREESTYLE_API_KEY" : "DAYTONA_API_KEY";
const sha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA;
const imageSha = process.env.OPENWORK_EVIDENCE_IMAGE_SHA || undefined;
if (!sha || !process.env[credential]?.trim()) throw new Error(`OPENWORK_EVIDENCE_SOURCE_SHA and ${credential} are required`);
const started = performance.now();
const stages: { stage: string; durationMs: number; cacheHit?: boolean; reason?: string }[] = [];
const options = {
  imageSha,
  observe: (event: { stage: string; durationMs: number; cacheHit?: boolean; reason?: string }) => { stages.push(event); console.log(JSON.stringify(event)); },
  // The builder VM is credential-free and built from this public commit; its
  // log tail is the fastest way to see why the shared e2e/preview world failed.
  diagnostic: async (stage: string, log: string) => {
    console.log(`::group::${stage} builder log (last 80 lines)`);
    console.log(log.split("\n").slice(-80).join("\n"));
    console.log("::endgroup::");
  },
};
try {
  if (provider === "freestyle") {
    const { ensureEvidenceSnapshot } = await import("../packages/freestyle/src/evidence-builder.ts");
    await ensureEvidenceSnapshot(sha, undefined, options);
  } else {
    const { ensureEvidenceTemplate, ensureImage } = await import("../packages/daytona-evidence/src/builder.ts");
    if (process.env.OPENWORK_DAYTONA_EPHEMERAL_WORLD === "1") {
      // Prepare the expensive shared dependencies here. The journey builds its
      // own running VM and consumes it in-process, without saving a PR template.
      const { devHead } = await import("../packages/freestyle/src/evidence-builder.ts");
      const { DaytonaApi } = await import("../packages/daytona-evidence/src/api.ts");
      await ensureImage(new DaytonaApi(), imageSha ?? await devHead(), options);
    } else {
      await ensureEvidenceTemplate(sha, undefined, options);
    }
  }
  const prepared = provider === "daytona" && process.env.OPENWORK_DAYTONA_EPHEMERAL_WORLD === "1" ? "dependencies ready; journey will prepare its ephemeral world" : "world ready";
  console.log(`${label} ${prepared} for ${sha} in ${Math.round((performance.now() - started) / 1000)}s`);
} catch (error) {
  console.error(`::error::${label} world preparation failed: ${error instanceof Error ? error.message : String(error)}. See the builder log group above.`);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    const path = stages.find((stage) => stage.stage.startsWith("path:"));
    const rows = stages.filter((stage) => stage.cacheHit !== undefined && !stage.stage.startsWith("path:"))
      .map((stage) => `| ${stage.stage} | ${stage.cacheHit ? "reused" : "built"} | ${Math.round(stage.durationMs / 1000)}s |`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${label} world\n\n${path ? `**${path.stage.slice(6)}** (${path.reason})\n\n` : ""}| Layer | Result | Time |\n| --- | --- | --- |\n${rows.join("\n")}\n`);
  }
}
