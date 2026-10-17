import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WORKSHOP_SCENES, WORKSHOP_LIMITS } from "./workshop-narrative-contract.ts";
const root = new URL("../../", import.meta.url);
const files = [
  "evals/proofs/workshop-artifact-diagnostic.proof.test.ts", "evals/worlds/workshop-workflow-frame.ts", "evals/worlds/workshop-turn-diagnostics.ts", "evals/proofs/workshop-turn-diagnostic.proof.test.ts", "evals/proofs/workshop-narrative.proof.test.ts", "evals/worlds/workshop-narrative.ts", "evals/worlds/workshop-narrative-inference.ts", "evals/worlds/workshop-narrative-contract.ts", "evals/worlds/workshop-narrative-witnesses.ts", "evals/worlds/workshop-workflow-witness.ts", "evals/worlds/workshop-comparison-semantics.ts", "evals/worlds/workshop-feedback.ts", "evals/worlds/workshop-pptx.ts", "evals/worlds/workshop-run-budget.ts", "evals/worlds/workshop-run-identity.ts", "evals/docs-shots/shots/workshop.ts", "worlds/lib/workshop-inference.ts", "evals/packages/labs/src/demo-atlassian.mjs", "evals/packages/labs/src/demo-microsoft365.mjs", "evals/packages/labs/src/demo-workshop-news.mjs", "evals/packages/labs/src/demo-workplace-ui.mjs", "evals/packages/labs/src/workshop-feedback.mjs", "evals/packages/labs/src/workshop-feedback-preload.mjs",
];
/** Whole-proof hashing includes recipient prompts and assertions, not only scene text. */
export async function workshopRunIdentity() {
  const hash = createHash("sha256");
  for (const path of files) hash.update(path).update(await readFile(new URL(path, root)));
  const revision = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(root) });
  return { gitSha: revision.stdout.trim(), sourceDigest: hash.digest("hex"), promptDigest: createHash("sha256").update(JSON.stringify({ scenes: WORKSHOP_SCENES, limits: WORKSHOP_LIMITS })).digest("hex") };
}
