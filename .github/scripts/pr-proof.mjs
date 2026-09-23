import { createHash } from "node:crypto";

const SPEC = /^evals\/specs\/.+\.e2e\.test\.ts$/;

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

export function proofLanes(specs, { event, current, repo, actor, triggeringActor }) {
  const liveSpecs = specs.filter(spec => spec === "evals/specs/live-stream-continuity.e2e.test.ts");
  const normalSpecs = specs.filter(spec => !liveSpecs.includes(spec));
  if (liveSpecs.length) {
    const repository = event?.repository;
    const sameRepo = candidate => Number.isSafeInteger(repository?.id) && repository.id > 0
      && repository.full_name === repo && candidate?.id === repository.id
      && candidate.full_name === repo && candidate.fork === false;
    const identities = [actor, triggeringActor, event?.pull_request?.user?.login, current?.user?.login];
    if (![event?.pull_request, current].every(pr => sameRepo(pr?.head?.repo) && sameRepo(pr?.base?.repo))
      || identities.some(login => typeof login !== "string" || !login || login.toLowerCase() === "dependabot[bot]")) {
      throw new Error("Live PR proof is unsupported for forks, untrusted repository metadata, or Dependabot. A maintainer must move the reviewed change to a same-repository PR and approve the pr-slow-specs environment; do not bypass or skip the selected live spec.");
    }
  }
  return { normalSpecs, liveSpecs };
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
