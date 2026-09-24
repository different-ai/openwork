export const supportedTargets = ["freestyle/linux"];

import { ensureEvidenceSnapshot } from "../packages/freestyle/src/evidence-builder.ts";
import { launchEvidenceWorld, deleteEvidenceVm } from "../packages/freestyle/src/checkpoints.ts";
import { hold } from "../packages/world/src/hold.ts";
import { secret } from "../packages/world/src/outputs.ts";
import { sourceFor, sourcesFromEnv } from "../packages/world/src/source.ts";
import { targetFromEnv } from "../packages/world/src/target.ts";
import { trackResource } from "../packages/world/src/ledger.ts";

export async function main() {
  const target = targetFromEnv();
  if (target.provider !== "freestyle" || target.os !== "linux") throw new Error("Evidence web requires freestyle/linux");
  const source = sourceFor(sourcesFromEnv(), "app-web");
  if (source?.kind !== "sha") throw new Error("Evidence web requires --source app-web=sha:<full pushed SHA>");
  await using resources = new AsyncDisposableStack();
  const template = await ensureEvidenceSnapshot(source.sha);
  const session = await launchEvidenceWorld(template.id, source.sha);
  resources.defer(() => deleteEvidenceVm(session.id));
  await trackResource({ kind: "freestyle-evidence", id: session.id, match: session.id, label: "evidence-web" });
  await hold({ name: "evidence-web", outputs: { viewer: secret(session.url), sourceSha: source.sha, expiresAt: session.expiresAt } });
}
if (import.meta.main) await main();
