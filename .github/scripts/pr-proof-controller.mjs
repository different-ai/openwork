import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { changedFiles, packagedJourney, proofKey, proofLanes, selectProof } from "./pr-proof.mjs";

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!event.pull_request) throw new Error("Proof selection requires a pull request event.");
const repo = process.env.GITHUB_REPOSITORY;
const pr = event.pull_request.number;
function api(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("GitHub proof selection unavailable.");
  return JSON.parse(result.stdout);
}
const current = api(`repos/${repo}/pulls/${pr}`);
if (current.head.sha !== event.pull_request.head.sha) throw new Error("PR head changed; rerun proof selection on the current head.");
const files = await changedFiles(api, repo, pr, current.changed_files);
const { specs } = selectProof(files);
if (specs.length > 32) throw new Error("More than 32 changed E2E specs; bounded CI selection unavailable. Split the change.");
const trust = { event, repo, actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR };
proofLanes(specs, { ...trust, current });
const latest = api(`repos/${repo}/pulls/${pr}`);
if (latest.head.sha !== current.head.sha) throw new Error("PR head changed during selection.");
const { normalSpecs, liveSpecs, packagedSpecs, daytonaSpecs, checkpointSpecs } = proofLanes(specs, { ...trust, current: latest });
const matrix = selected => JSON.stringify({ include: selected.map(spec => ({ spec, key: proofKey(spec) })) });
const packagedMatrix = selected => JSON.stringify({ include: selected.map(spec => ({ spec, key: proofKey(spec), journey: packagedJourney(spec) })) });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
  `matrix=${matrix(normalSpecs)}\nselected=${normalSpecs.length > 0}\nliveMatrix=${matrix(liveSpecs)}\nliveSelected=${liveSpecs.length > 0}\npackagedMatrix=${packagedMatrix(packagedSpecs)}\npackagedSelected=${packagedSpecs.length > 0}\ndaytonaMatrix=${matrix(daytonaSpecs)}\ndaytonaSelected=${daytonaSpecs.length > 0}\ncheckpointMatrix=${matrix(checkpointSpecs)}\ncheckpointSelected=${checkpointSpecs.length > 0}\n`);
const summary = specs.length
  ? `## PR proof selection\n\n${specs.length} added or changed E2E spec(s) will run on this head; their records are the PR's proof.\n\n${specs.map(spec => `- \`${spec}\``).join("\n")}\n`
  : "## PR proof selection\n\nThis PR adds or changes no `evals/specs/**/*.e2e.test.ts`. No proof was executed and no evidence will be published for it.\n";
const liveSummary = liveSpecs.length || daytonaSpecs.length
  ? "\nLive/Windows proof requires reviewer approval of the `pr-slow-specs` environment. Daytona Windows proof runs the exact published installer on a private VM; ordinary proof remains unprotected and secret-free.\n"
  : "";
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + liveSummary);
console.log(summary + liveSummary);
