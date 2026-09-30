import { ensureEvidenceSnapshot } from "../packages/freestyle/src/evidence-builder.ts";
const sha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA;
if (!sha || !process.env.FREESTYLE_API_KEY?.trim()) throw new Error("OPENWORK_EVIDENCE_SOURCE_SHA and FREESTYLE_API_KEY are required");
try {
  await ensureEvidenceSnapshot(sha, undefined, { observe: (event) => console.log(JSON.stringify(event)) });
  console.log(`Evidence web world ready for ${sha}`);
} catch {
  console.error("Evidence web world preparation failed. Inspect the private builder diagnostics; no checkpoint proof has passed.");
  process.exitCode = 1;
}
