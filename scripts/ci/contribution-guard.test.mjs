import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_ALLOWLIST, CLA_LABEL, DCO_ENFORCED_FROM, evaluate, isNoreplyFor, report } from "./contribution-guard.mjs";

const REPO = "different-ai/openwork";
const FORK = "contributor/openwork";
const LOGIN = "contributor";
// Author dates on either side of the same-repository grace cutoff.
const AFTER_CUTOFF = new Date(Date.parse(DCO_ENFORCED_FROM) + 60_000).toISOString();
const BEFORE_CUTOFF = new Date(Date.parse(DCO_ENFORCED_FROM) - 60_000).toISOString();

const commit = (
  sha,
  subject,
  { email = "dev@example.com", signoff = `Dev <${email}>`, parents = 1, date = AFTER_CUTOFF, githubAuthor = { login: LOGIN, type: "User" } } = {},
) => ({
  sha,
  parents: Array.from({ length: parents }, (_, index) => ({ sha: `parent${index}` })),
  author: githubAuthor,
  commit: {
    author: { name: "Dev", email, date },
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

test("fork commits get no grace: an old unsigned fork commit still fails", () => {
  const result = evaluate(forkPull({
    commits: [commit("f".repeat(40), "old fork work", { signoff: null, date: BEFORE_CUTOFF })],
  }));
  assert.equal(result.verdict, "fail");
  assert.equal(result.exempt.legacy, 0);
});

// Same-repository pull requests: DCO applies to everyone, the ee/ label rule does not.

const samePull = (overrides = {}) => forkPull({ headRepository: REPO, prAuthorLogin: "employee", ...overrides });

test("same-repository: every commit signed off passes and the ee/ label is not required", () => {
  const result = evaluate(samePull({ files: [{ filename: "ee/apps/den-api/src/index.ts" }] }));
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.ee, []);
  assert.match(report(result), /same-repository pull request; the `ee\/` CLA-label rule applies to forks only/);
});

test("same-repository: a missing trailer fails and names the commit", () => {
  const result = evaluate(samePull({
    commits: [commit("a".repeat(40), "feat: one"), commit("b".repeat(40), "wip", { signoff: null })],
  }));
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.dco, ['bbbbbbb "wip": missing Signed-off-by trailer']);
});

test("same-repository: a mismatched sign-off email fails", () => {
  const result = evaluate(samePull({
    commits: [commit("c".repeat(40), "chore: three", { signoff: "Other <other@example.com>" })],
  }));
  assert.equal(result.verdict, "fail");
  assert.match(result.dco[0], /Signed-off-by email does not match/);
});

test("same-repository: the PR author's GitHub noreply address passes", () => {
  const result = evaluate(samePull({
    commits: [commit("d".repeat(40), "chore: four", { signoff: "Employee <686630+employee@users.noreply.github.com>" })],
  }));
  assert.equal(result.verdict, "pass");
});

test("same-repository: merge commits are skipped", () => {
  const result = evaluate(samePull({
    commits: [commit("e".repeat(40), "Merge branch 'dev'", { signoff: null, parents: 2 })],
  }));
  assert.equal(result.verdict, "pass");
  assert.equal(result.exempt.merge, 1);
});

test("same-repository: commits authored before the cutoff are grandfathered; the cutoff itself is not", () => {
  const legacy = evaluate(samePull({
    commits: [commit("1".repeat(40), "pre-enforcement work", { signoff: null, date: BEFORE_CUTOFF })],
  }));
  assert.equal(legacy.verdict, "pass");
  assert.equal(legacy.exempt.legacy, 1);
  assert.match(report(legacy), /1 grandfathered/);

  const boundary = evaluate(samePull({
    commits: [commit("2".repeat(40), "at cutoff", { signoff: null, date: DCO_ENFORCED_FROM })],
  }));
  assert.equal(boundary.verdict, "fail");

  // A missing author date fails closed.
  const undated = evaluate(samePull({
    commits: [commit("3".repeat(40), "no date", { signoff: null, date: undefined })],
  }));
  assert.equal(undated.verdict, "fail");
});

test("bot allow-list: sentry and dependabot commits on their own PRs are exempt", () => {
  for (const login of BOT_ALLOWLIST) {
    const result = evaluate(samePull({
      prAuthorLogin: login,
      commits: [commit("4".repeat(40), "fix: generated", {
        signoff: null,
        email: `123+${login}@users.noreply.github.com`,
        githubAuthor: { login, type: "Bot" },
      })],
    }));
    assert.equal(result.verdict, "pass", login);
    assert.equal(result.exempt.bot, 1);
  }
  assert.deepEqual([...BOT_ALLOWLIST].sort(), ["dependabot[bot]", "sentry[bot]"]);
});

test("bot allow-list: a human commit on a bot PR, an unlisted bot, and a bot commit on a human PR are all checked", () => {
  const humanOnBotBranch = evaluate(samePull({
    prAuthorLogin: "dependabot[bot]",
    commits: [
      commit("5".repeat(40), "chore(deps): bump x", { signoff: null, githubAuthor: { login: "dependabot[bot]", type: "Bot" } }),
      commit("6".repeat(40), "fix: allow transitive deps", { signoff: null, email: "maintainer@example.com" }),
    ],
  }));
  assert.equal(humanOnBotBranch.verdict, "fail");
  assert.deepEqual(humanOnBotBranch.dco, ['6666666 "fix: allow transitive deps": missing Signed-off-by trailer']);

  const unlistedBot = evaluate(samePull({
    prAuthorLogin: "github-actions[bot]",
    commits: [commit("7".repeat(40), "docs(changelog): release notes", { signoff: null, githubAuthor: { login: "github-actions[bot]", type: "Bot" } })],
  }));
  assert.equal(unlistedBot.verdict, "fail");

  const spoofedOnHumanPull = evaluate(samePull({
    commits: [commit("8".repeat(40), "fix: looks generated", { signoff: null, githubAuthor: { login: "sentry[bot]", type: "Bot" } })],
  }));
  assert.equal(spoofedOnHumanPull.verdict, "fail");
});
