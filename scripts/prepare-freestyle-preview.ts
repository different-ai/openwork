import { previewWorld } from "../packages/freestyle/src/index.ts";
import { ensureSnapshot } from "../packages/freestyle/src/builder.ts";
import { appendFile, writeFile } from "node:fs/promises";
import type { BuildStage } from "../packages/freestyle/src/cache.ts";

const sha = process.argv[2];
if (!sha) throw new Error("Usage: node --env-file=.env.freestyle.local scripts/prepare-freestyle-preview.ts <full-pushed-sha>");
const world = previewWorld(process.argv[3] ?? "app-web");
const stages: BuildStage[] = [];
const start = performance.now();
const snapshot = await ensureSnapshot(sha, undefined, (message) => console.error(message), world, { observe: (event) => stages.push(event) });
const totalMs = Math.round(performance.now() - start);
const proof = { gitSha: sha, world, totalMs, stages,
  scope: "Wall time from snapshot preparation request to immutable running snapshot. Includes cache misses when present; excludes runner setup and subsequent clone verification." };
await writeFile(`freestyle-build-proof-${world}.json`, JSON.stringify(proof, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `\n## ${world} snapshot preparation\n\nTotal: ${(totalMs / 1000).toFixed(1)} seconds.\n\n| Stage | Seconds | Cache |\n| --- | --- | --- |\n${stages.map((event) => `| ${event.stage} | ${(event.durationMs / 1000).toFixed(1)} | ${event.cacheHit === undefined ? "—" : event.cacheHit ? "hit" : "built"} |`).join("\n")}\n\n${proof.scope} Parent layer times are included in a cold dependency build; do not sum nested stages.\n`);
console.log(JSON.stringify({ gitSha: sha, snapshotId: snapshot.id, slug: snapshot.slug }));
