import { createHash } from "node:crypto";

const SPEC = /^evals\/specs\/.+\.e2e\.test\.ts$/;
const PACKAGED_SPEC = /^evals\/specs\/packaged-[^/]+\.e2e\.test\.ts$/;
const DAYTONA_SPEC = "evals/specs/windows-published-preview.e2e.test.ts";
// A spec opts into checkpoints with the Vitest tag, e.g. `{ tags: ["checkpoints"] }`.
const CHECKPOINTS_TAG = /\btags\s*:\s*\[[^\]]*["'`]checkpoints["'`]/;

/** True when a spec's source tags a test "checkpoints"; CI then runs it with --checkpoints. */
export function checkpointTagged(source) {
  return typeof source === "string" && CHECKPOINTS_TAG.test(source);
}

/** The packaged smoke journey a packaged spec runs as (its file name without the suffix). */
export function packagedJourney(spec) {
  if (!safePath(spec) || !PACKAGED_SPEC.test(spec)) throw new Error("Invalid packaged proof spec path.");
  return spec.slice("evals/specs/".length, -".e2e.test.ts".length);
}

export function safePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 240
    && !path.startsWith("/") && !/[\\\0-\x1f\x7f]/u.test(path)
    && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

// Core journeys run on every PR that changes more than docs. Their end-state
// checkpoint is the PR's hands-on preview in the review app.
export const CORE_SPECS = ["evals/specs/core-chat.e2e.test.ts"];
const docsOnlyFile = path => path.startsWith("packages/docs/") || path.endsWith(".md");

// Every E2E spec the PR added or changed is a proof of its work, plus the core
// journeys unless the PR only touches docs.
export function selectProof(files) {
  if (!Array.isArray(files) || files.some(file => !safePath(file.filename) || (file.previous_filename !== undefined && !safePath(file.previous_filename))))
    throw new Error("Missing or unsafe changed-file listing; proof selection is unavailable.");
  if (new Set(files.map(file => file.filename)).size !== files.length) throw new Error("Duplicate changed files; proof selection is unavailable.");
  const changed = files
    .filter(file => ["added", "modified", "renamed", "changed", "copied"].includes(file.status) && SPEC.test(file.filename))
    .map(file => file.filename);
  const core = files.some(file => !docsOnlyFile(file.filename)) ? CORE_SPECS : [];
  const specs = [...new Set([...changed, ...core])].sort();
  return { specs };
}

export function proofLanes(allSpecs, { event, current, repo, actor, triggeringActor }, tagged = () => false) {
  // Forks and Dependabot cannot reach the Freestyle credential; they skip the
  // core journeys instead of failing selection. A changed checkpoint spec still fails below.
  const specs = trustedProofContext({ event, current, repo, actor, triggeringActor }) ? allSpecs : allSpecs.filter(spec => !CORE_SPECS.includes(spec));
  const liveSpecs = specs.filter(spec => ["evals/specs/live-stream-continuity.e2e.test.ts", "evals/specs/engine-live-chat.e2e.test.ts"].includes(spec));
  // Packaged specs boot a packaged desktop binary, which only the packaged
  // smoke runner builds; running them against a dev build always fails.
  const packagedSpecs = specs.filter(spec => PACKAGED_SPEC.test(spec));
  // Windows release proof requires a Daytona Windows VM and a real installer.
  // It cannot be rerouted to local Linux to obtain a green but meaningless run.
  const daytonaSpecs = specs.filter(spec => spec === DAYTONA_SPEC);
  // Core journeys get their own slim job: the app runs in Freestyle, the runner only drives it.
  const coreSpecs = specs.filter(spec => CORE_SPECS.includes(spec));
  // Checkpoint runs need the Freestyle credential, so they use the protected lane.
  const checkpointSpecs = specs.filter(spec => !coreSpecs.includes(spec) && !liveSpecs.includes(spec) && !packagedSpecs.includes(spec) && !daytonaSpecs.includes(spec) && tagged(spec));
  const normalSpecs = specs.filter(spec => !coreSpecs.includes(spec) && !liveSpecs.includes(spec) && !packagedSpecs.includes(spec) && !daytonaSpecs.includes(spec) && !checkpointSpecs.includes(spec));
  if (liveSpecs.length || daytonaSpecs.length || checkpointSpecs.length) {
    if (!trustedProofContext({ event, current, repo, actor, triggeringActor })) {
      throw new Error("Live PR proof is unsupported for forks, untrusted repository metadata, or Dependabot. A maintainer must move the reviewed change to a same-repository PR (organization members run automatically; other contributors need pr-slow-specs approval); do not bypass or skip the selected live or Windows spec.");
    }
  }
  return { coreSpecs, normalSpecs, liveSpecs, packagedSpecs, daytonaSpecs, checkpointSpecs };
}

function trustedProofContext({ event, current, repo, actor, triggeringActor }) {
  const repository = event?.repository;
  const sameRepo = candidate => Number.isSafeInteger(repository?.id) && repository.id > 0
    && repository.full_name === repo && candidate?.id === repository.id
    && candidate.full_name === repo && candidate.fork === false;
  const identities = [actor, triggeringActor, event?.pull_request?.user?.login, current?.user?.login];
  return [event?.pull_request, current].every(pr => sameRepo(pr?.head?.repo) && sameRepo(pr?.base?.repo))
    && identities.every(login => typeof login === "string" && login.length > 0 && login.toLowerCase() !== "dependabot[bot]");
}

export async function changedFiles(api, repo, pr, expectedCount) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 3000) throw new Error("Changed-file count is unavailable or exceeds GitHub's 3000-file limit.");
  const files = [];
  for (let page = 1; page <= Math.ceil(expectedCount / 100); page++) {
    const entries = await api(`repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!Array.isArray(entries) || entries.length !== Math.min(100, expectedCount - files.length)) throw new Error("Changed-file pagination is incomplete.");
    files.push(...entries);
  }
  if (files.length !== expectedCount) throw new Error("Changed-file listing is incomplete.");
  return files;
}

export function proofKey(spec) {
  if (!safePath(spec) || !SPEC.test(spec)) throw new Error("Invalid proof spec path.");
  return createHash("sha256").update(spec).digest("hex");
}

export function proofArtifact(spec, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid proof attempt.");
  return `pr-proof-${attempt}-${proofKey(spec)}`;
}
