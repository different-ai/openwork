import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { internalProofContributor } from "./internal-proof-contributor.mjs";
import { CORE_SPECS, changedFiles, checkpointTagged, packagedJourney, packagedProofOs, proofKey, proofLanes, safePath, selectProof } from "./pr-proof.mjs";

const repo = process.env.GITHUB_REPOSITORY;
function api(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("GitHub proof selection unavailable.");
  return JSON.parse(result.stdout);
}
let event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
// PRs no longer run proof automatically. A manual run names the PR and must be
// dispatched on its head branch at its current head commit; the PR as GitHub
// reports it stands in for the event. Secret-bearing lanes (core journey,
// checkpoints) check the real event in the workflow and stay off for it.
if (!event.pull_request) {
  const number = process.env.PROOF_PR ?? "";
  if (!/^\d+$/.test(number)) throw new Error("Proof selection requires a pull request event or a PR number.");
  const pull = api(`repos/${repo}/pulls/${number}`);
  if (pull.head.sha !== process.env.GITHUB_SHA) throw new Error("Run PR change proof on the PR's head branch at its current head commit.");
  event = { pull_request: pull, repository: api(`repos/${repo}`) };
}
const pr = event.pull_request.number;
const current = api(`repos/${repo}/pulls/${pr}`);
if (current.head.sha !== event.pull_request.head.sha) throw new Error("PR head changed; rerun proof selection on the current head.");
const files = await changedFiles(api, repo, pr, current.changed_files);
const { specs } = selectProof(files);
if (specs.length > 32) throw new Error("More than 32 changed E2E specs; bounded CI selection unavailable. Split the change.");
const trust = { event, repo, actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR };
// The checkout is the PR head; only spec sources are read, never executed here.
const taggedSpecs = new Set();
// An unreadable spec is untagged; its own run reports the problem.
for (const spec of specs) if (safePath(spec) && checkpointTagged(await readFile(spec, "utf8").catch(() => ""))) taggedSpecs.add(spec);
const tagged = spec => taggedSpecs.has(spec);
proofLanes(specs, { ...trust, current }, tagged);
const latest = api(`repos/${repo}/pulls/${pr}`);
if (latest.head.sha !== current.head.sha) throw new Error("PR head changed during selection.");
const { coreSpecs, normalSpecs, packagedSpecs, checkpointSpecs } = proofLanes(specs, { ...trust, current: latest }, tagged);
const internalContributor = internalProofContributor(event.pull_request, event.repository) && internalProofContributor(latest, event.repository);
const matrix = selected => JSON.stringify({ include: selected.map(spec => ({ spec, key: proofKey(spec) })) });
const packagedMatrix = selected => JSON.stringify({ include: selected.map(spec => ({ spec, key: proofKey(spec), journey: packagedJourney(spec), os: packagedProofOs(spec) })) });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
  `head=${latest.head.sha}\ninternalContributor=${internalContributor}\ncoreMatrix=${matrix(coreSpecs)}\ncoreSelected=${coreSpecs.length > 0}\nmatrix=${matrix(normalSpecs)}\nselected=${normalSpecs.length > 0}\npackagedMatrix=${packagedMatrix(packagedSpecs)}\npackagedSelected=${packagedSpecs.length > 0}\ncheckpointMatrix=${matrix(checkpointSpecs)}\ncheckpointSelected=${checkpointSpecs.length > 0}\n`);
const running = [...coreSpecs, ...normalSpecs, ...packagedSpecs, ...checkpointSpecs].sort();
const label = spec => CORE_SPECS.includes(spec) ? `- \`${spec}\` (core journey; its end state is this PR's preview)` : `- \`${spec}\``;
const summary = running.length
  ? `## PR proof selection\n\n${running.length} E2E spec(s) will run on this head; their records are the PR's proof.\n\n${running.map(label).join("\n")}\n`
  : "## PR proof selection\n\nNo E2E spec runs on this head (docs-only change, or core journeys unavailable to forks). No evidence will be published for it.\n";
const liveSummary = checkpointSpecs.length
  ? (internalContributor
    ? "\nProof for this internal organization contributor runs automatically in `pr-internal-specs`.\n"
    : "\nProof for this contributor requires reviewer approval of the `pr-slow-specs` environment.\n")
    + "Specs tagged `checkpoints` save reopenable checkpoints on Freestyle; ordinary proof remains unprotected and secret-free.\n"
  : "";
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + liveSummary);
console.log(summary + liveSummary);
