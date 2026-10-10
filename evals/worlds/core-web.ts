import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freestyleEvidenceWeb } from "@openwork/env";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The core PR world: this commit's app-web, signed in to a seeded Acme org with
 * a deterministic model, booted from the shared Freestyle evidence template.
 * Its end-state checkpoint is the PR's hands-on preview.
 */
export async function coreWebWorld() {
  // CI sets the PR head (the checkout); the world check passes throwaway commits.
  const sourceSha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("OPENWORK_EVIDENCE_SOURCE_SHA must be a full commit SHA");
  return { ...(await freestyleEvidenceWeb(sourceSha)), sourceSha };
}
