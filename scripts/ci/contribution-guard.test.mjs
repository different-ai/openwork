import assert from "node:assert/strict";
import { test } from "node:test";
import { CLA_LABEL, evaluate, isNoreplyFor, report } from "./contribution-guard.mjs";

const REPO = "different-ai/openwork";
const FORK = "contributor/openwork";
const LOGIN = "contributor";

const commit = (sha, subject, { email = "dev@example.com", signoff = `Dev <${email}>`, parents = 1 } = {}) => ({
  sha,
  parents: Array.from({ length: parents }, (_, index) => ({ sha: `parent${index}` })),
  commit: {
    author: { name: "Dev", email },
    message: signoff ? `${subject}\n\nSigned-off-by: ${signoff}\n` : `${subject}\n`,
  },
});

const forkPull = (overrides = {}) => ({
  repository: REPO,
  headRepository: FORK,
  prAuthorLogin: LOGIN,
  labels: [],
  commits: [commit("a".repeat(40), "feat: one"), commit("b".repeat(40), "fix: two")],
  files: [{ filename: "apps/desktop/src/main.ts" }],
  ...overrides,
});

test("all commits signed off with a matching email pass", () => {
  const result = evaluate(forkPull());
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.dco, []);
  assert.deepEqual(result.ee, []);
});

test("one unsigned commit fails and names the commit", () => {
  const result = evaluate(forkPull({
    commits: [commit("a".repeat(40), "feat: one"), commit("b".repeat(40), "fix: two", { signoff: null })],
  }));
  assert.equal(result.verdict, "fail");
  assert.equal(result.dco.length, 1);
  assert.match(result.dco[0], /^bbbbbbb "fix: two": missing Signed-off-by trailer$/);
  assert.match(report(result), /git commit -s/);
  assert.match(report(result), /git rebase --signoff/);
  assert.match(report(result), /CONTRIBUTING\.md §1/);
});

test("a sign-off from someone else fails; the GitHub noreply address of the PR author passes", () => {
  const mismatch = evaluate(forkPull({
    commits: [commit("c".repeat(40), "chore: three", { signoff: "Other <other@example.com>" })],
  }));
  assert.equal(mismatch.verdict, "fail");
  assert.match(mismatch.dco[0], /^ccccccc "chore: three": Signed-off-by email does not match/);
  // Public logs must never carry contributor identifiers (Warden EQE-3T4).
  assert.doesNotMatch(report(mismatch), /@example\.com|@contributor|contributor'/);

  const noreply = evaluate(forkPull({
    commits: [commit("d".repeat(40), "chore: four", { signoff: `Dev <12345+${LOGIN}@users.noreply.github.com>` })],
  }));
  assert.equal(noreply.verdict, "pass");
  assert.equal(isNoreplyFor(`${LOGIN}@users.noreply.github.com`, LOGIN), true);
  assert.equal(isNoreplyFor(`${LOGIN}@users.noreply.github.com`, "someone-else"), false);
});

test("merge commits are not required to carry a sign-off", () => {
  const result = evaluate(forkPull({
    commits: [commit("e".repeat(40), "Merge branch 'dev'", { signoff: null, parents: 2 })],
  }));
  assert.equal(result.verdict, "pass");
});

test("an ee/ file without the CLA label fails and points at the CLA documents", () => {
  const result = evaluate(forkPull({
    files: [{ filename: "ee/apps/den-api/src/index.ts" }, { filename: "README.md" }],
  }));
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.ee, ["ee/apps/den-api/src/index.ts"]);
  assert.deepEqual(result.dco, []);
  const text = report(result);
  assert.match(text, /legal\/individual-contributor-license-agreement\.md/);
  assert.match(text, /legal\/corporate-contributor-license-agreement\.md/);
  assert.match(text, /CONTRIBUTING\.md §2/);
});

test("a file renamed out of ee/ still counts as touching ee/", () => {
  const result = evaluate(forkPull({
    files: [{ filename: "packages/moved.ts", previous_filename: "ee/packages/moved.ts" }],
  }));
  assert.deepEqual(result.ee, ["ee/packages/moved.ts"]);
});

test("an ee/ file with the cla-signed label passes", () => {
  const result = evaluate(forkPull({
    labels: [CLA_LABEL],
    files: [{ filename: "ee/apps/den-api/src/index.ts" }],
  }));
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.ee, []);
});

test("same-repository pull requests are skipped even when unsigned and touching ee/", () => {
  const result = evaluate(forkPull({
    headRepository: REPO,
    commits: [commit("f".repeat(40), "wip", { signoff: null })],
    files: [{ filename: "ee/LICENSE" }],
  }));
  assert.equal(result.verdict, "skipped");
  assert.deepEqual(result.dco, []);
  assert.deepEqual(result.ee, []);
  assert.match(report(result), /Skipped: same-repository pull request/);
});
