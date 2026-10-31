// CI selection policy only; build inputs live in build-inputs.mjs. Keep the
// classifier pure so its fail-open and required-check behavior can be tested
// without GitHub, package installs, or a desktop build.
// Selection outputs. `core` selects the unit-test jobs and the desktop build
// check; the slow suites below it are path-scoped on PRs and always follow
// their inputs on dev pushes.
const CHECKS = ["core", "desktop_smoke", "den_api", "snapshot", "docs", "den_contract"];
// Required jobs and the selection output each one follows. Every selected job
// must succeed and every unselected job must be skipped.
export const REQUIRED_JOBS = {
  core_app: "core",
  core_headless: "core",
  core_workbot: "core",
  core_den: "core",
  core_evals: "core",
  core_evals_lint: "core",
  desktop_build: "core",
  desktop_smoke: "desktop_smoke",
  den_api: "den_api",
  snapshot: "snapshot",
  docs: "docs",
  den_contract: "den_contract",
};
const SNAPSHOT = "ee/apps/gateway/src/models/base.json";
const STATUSES = new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]);
const objectId = (value) => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value) && !/^0+$/.test(value);
const safePath = (value) => typeof value === "string" && value.length > 0
  && !/[\\\0-\x1f\x7f]/u.test(value)
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const full = () => ({ lane: "full", core: true, desktop_smoke: true, den_api: true, snapshot: true, docs: true, den_contract: true });

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
export function classifyCiChanges({ eventName, files, expectedCount }, isAffected) {
  if (eventName === "schedule" || eventName === "workflow_dispatch") return full();
  if (eventName !== "pull_request" && eventName !== "push") return full();
  const changes = changesFrom(files);
  if (!changes) return full();
  if (eventName === "pull_request" && (!Number.isSafeInteger(expectedCount)
    || expectedCount < 0 || expectedCount > 3000 || expectedCount !== changes.length
    || changes.some((file) => !STATUSES.has(file.status)))) return full();

  // Push diffs are --no-renames paths; PRs carry status and both rename ends.
  // A deleted snapshot fails validation instead of silently passing a fast lane.
  const snapshotOnly = changes.length === 1 && changes[0].filename === SNAPSHOT
    && !changes[0].previous_filename
    && (changes[0].status === "modified" || (eventName === "push" && changes[0].status === undefined));
  if (snapshotOnly) return { lane: "snapshot", core: false, desktop_smoke: false, den_api: false, snapshot: true, docs: false, den_contract: false };

  const paths = [...new Set(changes.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)))];
  const docsOnly = paths.length > 0 && paths.every((path) => path.startsWith("packages/docs/"));
  const affected = (target) => {
    const result = isAffected(target, paths);
    if (typeof result !== "boolean") throw new Error(`Invalid input selection for ${target}`);
    return result;
  };
  try {
    if (eventName === "pull_request") {
      if (docsOnly) return { lane: "docs", core: false, desktop_smoke: affected("desktop-smoke"), den_api: false, snapshot: false, docs: true, den_contract: false };
      // Every non-docs PR runs the unit tests and the desktop build check. The
      // slow suites run only when their inputs change: the packaged desktop
      // (desktop shell, embedded server, engine pins, dependencies; dev pushes
      // package for every desktop input), the MySQL-backed Den API tests, and
      // the generated API contract. A docs-affecting workflow/helper or mixed
      // PR still exercises docs validation before merge.
      return {
        lane: "full", core: true,
        desktop_smoke: affected("desktop-package"),
        den_api: affected("den-api-tests"),
        snapshot: false,
        docs: affected("docs"),
        den_contract: affected("den-contract"),
      };
    }
    const core = affected("core");
    const selected = {
      core,
      desktop_smoke: affected("desktop-smoke"),
      // Dev pushes run the Den API security tests whenever unit tests run.
      den_api: core,
      snapshot: affected("models"),
      docs: affected("docs"),
      // Dev pushes retain the dedicated Generated Den SDK / API Contract
      // workflows. Unknown diffs above still fail open to all checks here.
      den_contract: false,
    };
    return { lane: docsOnly ? "docs" : CHECKS.some((check) => selected[check]) ? "affected" : "none", ...selected };
  } catch {
    return full();
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
export function assertSelectedChecks({ classification, staticChecks, selected, results }) {
  if (classification !== "success") throw new Error("Changed-file classification did not succeed; blocking merge.");
  if (staticChecks !== "success") throw new Error("Independent static checks did not pass; blocking merge.");
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
