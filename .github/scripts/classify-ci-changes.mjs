// CI selection policy only; build inputs live in build-inputs.mjs. Keep the
// classifier pure so its fail-open and required-check behavior can be tested
// without GitHub, package installs, or a desktop build.
const CHECKS = ["core", "desktop_smoke", "snapshot", "docs", "den_contract"];
const SNAPSHOT = "ee/apps/gateway/src/models/base.json";
const STATUSES = new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]);
const objectId = (value) => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value) && !/^0+$/.test(value);
const safePath = (value) => typeof value === "string" && value.length > 0
  && !/[\\\0-\x1f\x7f]/u.test(value)
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const full = () => ({ lane: "full", core: true, desktop_smoke: true, snapshot: true, docs: true, den_contract: true });

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
  if (snapshotOnly) return { lane: "snapshot", core: false, desktop_smoke: false, snapshot: true, docs: false, den_contract: false };

  const paths = [...new Set(changes.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)))];
  const docsOnly = paths.length > 0 && paths.every((path) => path.startsWith("packages/docs/"));
  const affected = (target) => {
    const result = isAffected(target, paths);
    if (typeof result !== "boolean") throw new Error(`Invalid input selection for ${target}`);
    return result;
  };
  try {
    if (eventName === "pull_request") {
      // Preserve full PR coverage (and the snapshot/docs fast lanes), rather
      // than using dev-push scoping to weaken the required merge gate.
      if (docsOnly) return { lane: "docs", core: false, desktop_smoke: affected("desktop-smoke"), snapshot: false, docs: true, den_contract: false };
      // A docs-affecting workflow/helper or mixed product/docs PR must exercise
      // the same validator before merge, not first discover failures on dev.
      return { lane: "full", core: true, desktop_smoke: true, snapshot: false, docs: affected("docs"), den_contract: affected("den-contract") };
    }
    const selected = {
      core: affected("core"),
      desktop_smoke: affected("desktop-smoke"),
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
  for (const values of [selected, results]) {
    if (!values || Object.keys(values).length !== CHECKS.length || Object.keys(values).some((key) => !CHECKS.includes(key))) {
      throw new Error("Missing or unexpected selected-check outputs; blocking merge.");
    }
  }
  for (const check of CHECKS) {
    const value = selected[check];
    if (value !== true && value !== false && value !== "true" && value !== "false") {
      throw new Error(`Invalid selection for ${check}; blocking merge.`);
    }
    const expected = value === true || value === "true" ? "success" : "skipped";
    if (results[check] !== expected) throw new Error(`${check}: expected ${expected}, received ${results[check]}; blocking merge.`);
  }
}
