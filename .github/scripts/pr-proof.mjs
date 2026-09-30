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

// Every E2E spec the PR added or changed is a proof of its work. Nothing is
// required; a PR that touches no spec simply produces no proof evidence.
export function selectProof(files) {
  if (!Array.isArray(files) || files.some(file => !safePath(file.filename) || (file.previous_filename !== undefined && !safePath(file.previous_filename))))
    throw new Error("Missing or unsafe changed-file listing; proof selection is unavailable.");
  if (new Set(files.map(file => file.filename)).size !== files.length) throw new Error("Duplicate changed files; proof selection is unavailable.");
  const specs = files
    .filter(file => ["added", "modified", "renamed", "changed", "copied"].includes(file.status) && SPEC.test(file.filename))
    .map(file => file.filename).sort();
  return { specs };
}

export function proofLanes(specs, { event, current, repo, actor, triggeringActor }, tagged = () => false) {
  const liveSpecs = specs.filter(spec => ["evals/specs/live-stream-continuity.e2e.test.ts", "evals/specs/engine-live-chat.e2e.test.ts"].includes(spec));
  // Packaged specs boot a packaged desktop binary, which only the packaged
  // smoke runner builds; running them against a dev build always fails.
  const packagedSpecs = specs.filter(spec => PACKAGED_SPEC.test(spec));
  // Windows release proof requires a Daytona Windows VM and a real installer.
  // It cannot be rerouted to local Linux to obtain a green but meaningless run.
  const daytonaSpecs = specs.filter(spec => spec === DAYTONA_SPEC);
  // Checkpoint runs need the Freestyle credential, so they use the protected lane.
  const checkpointSpecs = specs.filter(spec => !liveSpecs.includes(spec) && !packagedSpecs.includes(spec) && !daytonaSpecs.includes(spec) && tagged(spec));
  const normalSpecs = specs.filter(spec => !liveSpecs.includes(spec) && !packagedSpecs.includes(spec) && !daytonaSpecs.includes(spec) && !checkpointSpecs.includes(spec));
  if (liveSpecs.length || daytonaSpecs.length || checkpointSpecs.length) {
    const repository = event?.repository;
    const sameRepo = candidate => Number.isSafeInteger(repository?.id) && repository.id > 0
      && repository.full_name === repo && candidate?.id === repository.id
      && candidate.full_name === repo && candidate.fork === false;
    const identities = [actor, triggeringActor, event?.pull_request?.user?.login, current?.user?.login];
    if (![event?.pull_request, current].every(pr => sameRepo(pr?.head?.repo) && sameRepo(pr?.base?.repo))
      || identities.some(login => typeof login !== "string" || !login || login.toLowerCase() === "dependabot[bot]")) {
      throw new Error("Live PR proof is unsupported for forks, untrusted repository metadata, or Dependabot. A maintainer must move the reviewed change to a same-repository PR (organization members run automatically; other contributors need pr-slow-specs approval); do not bypass or skip the selected live or Windows spec.");
    }
  }
  return { normalSpecs, liveSpecs, packagedSpecs, daytonaSpecs, checkpointSpecs };
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
