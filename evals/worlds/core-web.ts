import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evidenceWeb, evidenceWorldCredentials } from "@openwork/env";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Credentials the selected provider needs, for the spec's `needs.env`. */
export const coreWebCredentials = () => evidenceWorldCredentials();

/**
 * The core PR world: this commit's app-web, signed in to a seeded Acme org with
 * a deterministic model, on the provider OPENWORK_EVIDENCE_PROVIDER selects
 * (Freestyle when unset). Its end-state checkpoint is the PR's hands-on preview.
 */
export async function coreWebWorld() {
  // CI sets the PR head (the checkout); the world check passes throwaway commits.
  const sourceSha = process.env.OPENWORK_EVIDENCE_SOURCE_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("OPENWORK_EVIDENCE_SOURCE_SHA must be a full commit SHA");
  return { ...(await evidenceWeb(sourceSha)), sourceSha };
}
