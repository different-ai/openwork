import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";

// Journeys live in evals/core (maintained) or
// evals/proofs (one-off agent proofs); a file can move between them and keeps
// its basename, so lanes compare journeys by basename.
const SPEC = /^evals\/(?:(?:specs|core)\/.+\.e2e|proofs\/.+\.proof)\.test\.ts$/;
const PACKAGED_SPEC = /^evals\/(?:specs|core)\/(packaged-[^/]+)\.e2e\.test\.ts$/;
const specBasename = spec => spec.slice(spec.lastIndexOf("/") + 1);
// A spec opts into checkpoints with the Vitest tag, e.g. `{ tags: ["checkpoints"] }`.
const CHECKPOINTS_TAG = /\btags\s*:\s*\[[^\]]*["'`]checkpoints["'`]/;

/** True when a spec's source tags a test "checkpoints"; CI then runs it with --checkpoints. */
export function checkpointTagged(source) {
  return typeof source === "string" && CHECKPOINTS_TAG.test(source);
}

/** The packaged smoke journey a packaged spec runs as (its file name without the suffix). */
export function packagedJourney(spec) {
  if (!safePath(spec) || !PACKAGED_SPEC.test(spec)) throw new Error("Invalid packaged proof spec path.");
  return PACKAGED_SPEC.exec(spec)[1];
}

// Packaged journeys that need a signed macOS bundle; packaged-smoke-macos.mjs
// builds and runs them. Any other packaged-* journey would run through the
// Linux packaged-smoke.mjs, which boots only app-smoke and rejects other names.
const MACOS_PACKAGED_JOURNEYS = new Set(["packaged-update-install"]);

/** Runner operating system a packaged proof spec needs: "macos" or "linux". */
export function packagedProofOs(spec) {
  return MACOS_PACKAGED_JOURNEYS.has(packagedJourney(spec)) ? "macos" : "linux";
}

export function safePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 240
    && !path.startsWith("/") && !/[\\\0-\x1f\x7f]/u.test(path)
    && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

// core-chat, the one PR core journey, runs on every PR that changes more than
// docs. It is off the required merge gate, and its end-state checkpoint is the
// PR's hands-on preview in the review app.
const repoRoot = new URL("../../", import.meta.url);
const journeyPath = name => ["core", "specs", "proofs"].map(folder => `evals/${folder}/${name}`).find(path => existsSync(new URL(path, repoRoot))) ?? `evals/core/${name}`;
export const CORE_SPECS = [journeyPath("core-chat.e2e.test.ts")];
const docsOnlyFile = path => path.startsWith("packages/docs/") || path.endsWith(".md");

// The other core journeys run on every dev push and nightly (core-journeys.yml),
// not on each PR; a PR runs one only when it adds or changes it, or when it
// changes this proof machinery. Packaged journeys need packaged binaries:
// app-smoke runs in packaged smoke, and packaged-update-install (macOS) runs
// nightly and when it changes.
const PACKAGED_ONLY = /^(packaged-[^/]+|app-smoke)\.e2e\.test\.ts$/;
// Too slow for machinery PRs (it relaunches the desktop app twice, ~8.5 min).
// It runs on dev pushes and nightly, and on any PR that changes it.
export const NIGHTLY_ONLY = new Set(["thread-continues-after-restart.e2e.test.ts"]);
// A PR that changes how proof is selected or run proves every core journey
// still runs under it. The trusted publisher on dev applies the same rule.
export const PROOF_MACHINERY = new Set([".github/scripts/pr-proof.mjs", ".github/scripts/pr-proof-controller.mjs", ".github/workflows/pr-proof.yml"]);
/** Core journeys other than core-chat, packaged and nightly-only ones. */
export function everyCoreJourney(root = repoRoot) {
  const directory = new URL("evals/core/", root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".e2e.test.ts") && !PACKAGED_ONLY.test(name) && !NIGHTLY_ONLY.has(name) && name !== "core-chat.e2e.test.ts").sort().map(name => `evals/core/${name}`);
}

// Every E2E spec the PR added or changed is a proof of its work, plus the
// core-chat journey unless the PR only touches docs.
export function selectProof(files, coreJourneys = everyCoreJourney()) {
  if (!Array.isArray(files) || files.some(file => !safePath(file.filename) || (file.previous_filename !== undefined && !safePath(file.previous_filename))))
    throw new Error("Missing or unsafe changed-file listing; proof selection is unavailable.");
  if (new Set(files.map(file => file.filename)).size !== files.length) throw new Error("Duplicate changed files; proof selection is unavailable.");
  const changed = files
    .filter(file => ["added", "modified", "renamed", "changed", "copied"].includes(file.status) && SPEC.test(file.filename))
    .map(file => file.filename);
  const machinery = files.some(file => PROOF_MACHINERY.has(file.filename) || PROOF_MACHINERY.has(file.previous_filename));
  const core = files.some(file => !docsOnlyFile(file.filename)) ? [...CORE_SPECS, ...(machinery ? coreJourneys : [])] : [];
  const specs = [...new Set([...changed, ...core])].sort();
  return { specs };
}

export function proofLanes(allSpecs, { event, current, repo, actor, triggeringActor }, tagged = () => false) {
  // Forks and Dependabot cannot reach the Freestyle credential; they skip the
  // core journeys instead of failing selection. A changed checkpoint spec still fails below.
  const specs = trustedProofContext({ event, current, repo, actor, triggeringActor }) ? allSpecs : allSpecs.filter(spec => !CORE_SPECS.includes(spec));
  // Packaged specs boot a packaged desktop binary, which only the packaged
  // smoke runner builds; running them against a dev build always fails.
  const packagedSpecs = specs.filter(spec => PACKAGED_SPEC.test(spec));
  // Core journeys get their own slim job: the app runs in Freestyle, the runner only drives it.
  const coreSpecs = specs.filter(spec => CORE_SPECS.includes(spec));
  // Checkpoint runs need the Freestyle credential, so they use the protected lane.
  const checkpointSpecs = specs.filter(spec => !coreSpecs.includes(spec) && !packagedSpecs.includes(spec) && tagged(spec));
  const normalSpecs = specs.filter(spec => !coreSpecs.includes(spec) && !packagedSpecs.includes(spec) && !checkpointSpecs.includes(spec));
  if (checkpointSpecs.length) {
    if (!trustedProofContext({ event, current, repo, actor, triggeringActor })) {
      throw new Error("Checkpoint PR proof is unsupported for forks, untrusted repository metadata, or Dependabot. A maintainer must move the reviewed change to a same-repository PR (organization members run automatically; other contributors need pr-slow-specs approval); do not bypass or skip the selected checkpoint spec.");
    }
  }
  return { coreSpecs, normalSpecs, packagedSpecs, checkpointSpecs };
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

const PROOF_ARTIFACT = /^pr-proof-([1-9]\d{0,3})-([a-f0-9]{64})$/;

/**
 * The proof artifact to publish for each selected spec: its newest attempt, up to
 * `attempt`. "Re-run failed jobs" keeps the passing jobs' records from the earlier
 * attempt (every attempt of a run tests the same commit), so one report can mix
 * attempts. Returns a map of artifact name to spec, or the reason to publish nothing.
 */
export function proofArtifactsForAttempt(artifacts, specs, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid proof attempt.");
  const specByKey = new Map(specs.map(spec => [proofKey(spec), spec]));
  const names = new Map();
  const newest = new Map();
  for (const artifact of artifacts) {
    const name = artifact?.name;
    if (typeof name !== "string" || !name.startsWith("pr-proof-")) continue;
    const match = PROOF_ARTIFACT.exec(name);
    const spec = match ? specByKey.get(match[2]) : undefined;
    const from = match ? Number(match[1]) : 0;
    if (!spec || from > attempt) return { reason: "unexpected proof artifact is present" };
    names.set(name, (names.get(name) ?? 0) + 1);
    if ((newest.get(spec)?.from ?? 0) < from) newest.set(spec, { from, name });
  }
  if (newest.size !== specByKey.size || [...newest.values()].some(({ name }) => names.get(name) !== 1))
    return { reason: "required proof artifact is missing or duplicated" };
  return { expected: new Map([...newest].map(([spec, { name }]) => [name, spec])) };
}
