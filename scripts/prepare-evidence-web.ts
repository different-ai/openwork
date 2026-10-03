import { ensureEvidenceSnapshot } from "../packages/freestyle/src/evidence-builder.ts";
const sha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA;
if (!sha || !process.env.FREESTYLE_API_KEY?.trim()) throw new Error("OPENWORK_EVIDENCE_SOURCE_SHA and FREESTYLE_API_KEY are required");
try {
  await ensureEvidenceSnapshot(sha, undefined, {
    observe: (event) => console.log(JSON.stringify(event)),
    // The builder VM is credential-free and built from this public commit; its
    // log tail is the fastest way to see why the shared e2e/preview world failed.
    diagnostic: async (stage, log) => {
      console.log(`::group::${stage} builder log (last 80 lines)`);
      console.log(log.split("\n").slice(-80).join("\n"));
      console.log("::endgroup::");
    },
  });
  console.log(`Evidence web world ready for ${sha}`);
} catch (error) {
  console.error(`::error::Evidence web world preparation failed: ${error instanceof Error ? error.message : String(error)}. See the builder log group above.`);
  process.exitCode = 1;
}
