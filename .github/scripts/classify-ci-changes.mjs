// CI selection policy only; build inputs live in build-inputs.mjs. Keep the
// classifier pure so its fail-open and required-check behavior can be tested
// without GitHub, package installs, or a desktop build.
// Dev-push selection ("Build and core checks"). PRs run only the quick check
// (quick-check.yml); everything below runs after merge. `core` selects the
// unit-test jobs and the desktop build check.
const CHECKS = ["core", "den_api", "snapshot", "docs"];
// Jobs and the selection output each one follows. Every selected job must
// succeed and every unselected job must be skipped.
export const REQUIRED_JOBS = {
  core_app: "core",
  core_headless: "core",
  core_workbot: "core",
  core_den: "core",
  core_evals: "core",
  core_evals_lint: "core",
  desktop_build: "core",
  den_api: "den_api",
  snapshot: "snapshot",
  docs: "docs",
};
// PR quick-check selection: the Den API auth and permission tests run when
// Den API inputs change. Typecheck and static checks always run.
export const QUICK_CHECKS = ["den_quick"];
const SNAPSHOT = "ee/apps/gateway/src/models/base.json";
const STATUSES = new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]);
const objectId = (value) => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value) && !/^0+$/.test(value);
const safePath = (value) => typeof value === "string" && value.length > 0
  && !/[\\\0-\x1f\x7f]/u.test(value)
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const full = () => ({ lane: "full", core: true, den_api: true, snapshot: true, docs: true });

function changesFrom(files) {
  if (!Array.isArray(files)) return null;
  const changes = [];
  const seen = new Set();
  for (const file of files) {
    const change = typeof file === "string" ? { filename: file } : file;
    if (!change || !safePath(change.filename) || seen.has(change.filename)
      || (change.status !== undefined && !STATUSES.has(change.status))
      || (change.previous_filename !== undefined && !safePath(change.previous_filename))
      || (change.status === "renamed" && !change.previous_filename)) return null;
    seen.add(change.filename);
    changes.push(change);
  }
  return changes;
}

/** A null/incomplete listing or failed input calculation selects every check. */
export function classifyCiChanges({ eventName, files }, isAffected) {
  // Only dev pushes are narrowed; schedules, manual runs and anything
  // unexpected (this workflow no longer runs on PRs) run every check.
  if (eventName !== "push") return full();
  const changes = changesFrom(files);
  if (!changes) return full();

  // Push diffs are --no-renames paths. A deleted snapshot fails validation
  // instead of silently passing a fast lane.
  const snapshotOnly = changes.length === 1 && changes[0].filename === SNAPSHOT
    && !changes[0].previous_filename
    && (changes[0].status === "modified" || changes[0].status === undefined);
  if (snapshotOnly) return { lane: "snapshot", core: false, den_api: false, snapshot: true, docs: false };

  const paths = [...new Set(changes.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)))];
  const docsOnly = paths.length > 0 && paths.every((path) => path.startsWith("packages/docs/"));
  const affected = (target) => {
    const result = isAffected(target, paths);
    if (typeof result !== "boolean") throw new Error(`Invalid input selection for ${target}`);
    return result;
  };
  try {
    const core = affected("core");
    const selected = {
      core,
      // Dev pushes run the full Den API security suite whenever unit tests run.
      den_api: core,
      snapshot: affected("models"),
      docs: affected("docs"),
    };
    return { lane: docsOnly ? "docs" : CHECKS.some((check) => selected[check]) ? "affected" : "none", ...selected };
  } catch {
    return full();
  }
}

/** PR quick check: which conditional quick jobs run. Unknown or incomplete diffs select them. */
export function classifyQuickChanges({ eventName, files, expectedCount }, isAffected) {
  // Dev pushes run the full suites in "Build and core checks"; a manual run checks everything.
  if (eventName === "push") return { den_quick: false };
  if (eventName !== "pull_request") return { den_quick: true };
  const changes = changesFrom(files);
  if (!changes || !Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 3000
    || expectedCount !== changes.length || changes.some((file) => !STATUSES.has(file.status))) return { den_quick: true };
  const paths = [...new Set(changes.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)))];
  try {
    const result = isAffected("den-api-tests", paths);
    if (typeof result !== "boolean") throw new Error("Invalid input selection for den-api-tests");
    return { den_quick: result };
  } catch {
    return { den_quick: true };
  }
}

/** Read every PR page and verify the list still describes this run's head. */
export async function pullRequestChanges({ github, owner, repo, number, head }) {
  const unknown = { files: null, expectedCount: null };
  try {
    const request = { owner, repo, pull_number: number };
    const { data: before } = await github.rest.pulls.get(request);
    if (!objectId(head) || before.head?.sha !== head || !objectId(before.base?.sha)
      || !Number.isSafeInteger(before.changed_files) || before.changed_files < 0 || before.changed_files > 3000) return unknown;
    const files = await github.paginate(github.rest.pulls.listFiles, { ...request, per_page: 100 });
    const { data: after } = await github.rest.pulls.get(request);
    if (after.head?.sha !== head || after.base?.sha !== before.base.sha
      || after.changed_files !== before.changed_files || !Array.isArray(files)
      || files.length !== before.changed_files) return unknown;
    return { files, expectedCount: before.changed_files };
  } catch {
    return unknown;
  }
}

/** Compare the entire pushed range, fetching only a missing base endpoint. */
export function pushChanges({ base, head, readDiff, fetchBase }) {
  if (!objectId(base) || !objectId(head)) return null;
  try {
    const files = readDiff({ base, head });
    if (files !== null) return files;
    fetchBase(base);
    return readDiff({ base, head });
  } catch {
    return null;
  }
}

/** The stable required context must check the actual booleans, not a lane label. */
export function assertSelectedChecks({ classification, selected, results }) {
  if (classification !== "success") throw new Error("Changed-file classification did not succeed; blocking merge.");
  const jobs = Object.keys(REQUIRED_JOBS);
  for (const [values, keys] of [[selected, CHECKS], [results, jobs]]) {
    if (!values || Object.keys(values).length !== keys.length || Object.keys(values).some((key) => !keys.includes(key))) {
      throw new Error("Missing or unexpected selected-check outputs; blocking merge.");
    }
  }
  for (const check of CHECKS) {
    const value = selected[check];
    if (value !== true && value !== false && value !== "true" && value !== "false") {
      throw new Error(`Invalid selection for ${check}; blocking merge.`);
    }
  }
  for (const job of jobs) {
    const value = selected[REQUIRED_JOBS[job]];
    const expected = value === true || value === "true" ? "success" : "skipped";
    if (results[job] !== expected) throw new Error(`${job}: expected ${expected}, received ${results[job]}; blocking merge.`);
  }
}

/** The PR quick check's required context: always-run checks pass, selected ones pass, unselected ones skip. */
export function assertQuickChecks({ classification, always, selected, results }) {
  if (classification !== "success") throw new Error("Changed-file classification did not succeed; blocking merge.");
  if (!always || Object.keys(always).length === 0) throw new Error("Missing always-run quick checks; blocking merge.");
  for (const [check, result] of Object.entries(always)) {
    if (result !== "success") throw new Error(`${check}: expected success, received ${result}; blocking merge.`);
  }
  for (const values of [selected, results]) {
    if (!values || Object.keys(values).length !== QUICK_CHECKS.length || Object.keys(values).some((key) => !QUICK_CHECKS.includes(key))) {
      throw new Error("Missing or unexpected selected-check outputs; blocking merge.");
    }
  }
  for (const check of QUICK_CHECKS) {
    const value = selected[check];
    if (value !== true && value !== false && value !== "true" && value !== "false") {
      throw new Error(`Invalid selection for ${check}; blocking merge.`);
    }
    const expected = value === true || value === "true" ? "success" : "skipped";
    if (results[check] !== expected) throw new Error(`${check}: expected ${expected}, received ${results[check]}; blocking merge.`);
  }
}
