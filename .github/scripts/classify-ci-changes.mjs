// CI selection policy only; build inputs live in build-inputs.mjs. Keep the
// classifier pure so its fail-open and required-check behavior can be tested
// without GitHub, package installs, or a desktop build.
// Quick-check selection: on a PR the Den API auth and permission tests run
// when Den API inputs change. Everything else always runs.
export const QUICK_CHECKS = ["den_quick"];
const STATUSES = new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]);
const objectId = (value) => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value) && !/^0+$/.test(value);
const safePath = (value) => typeof value === "string" && value.length > 0
  && !/[\\\0-\x1f\x7f]/u.test(value)
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

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

/** PR quick check: which conditional quick jobs run. Unknown or incomplete diffs select them. */
export function classifyQuickChanges({ eventName, files, expectedCount }, isAffected) {
  // Only PRs are narrowed. A dev push runs everything: its result is what the
  // alpha build and the release require of that commit.
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

/** The quick check's required context: always-run checks pass, selected ones pass, unselected ones skip. */
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
