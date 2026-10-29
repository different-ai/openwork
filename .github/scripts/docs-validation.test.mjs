import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isBuildAffected } from "./build-inputs.mjs";
import { classifyCiChanges } from "./classify-ci-changes.mjs";

const workflow = readFileSync(new URL("../workflows/ci-tests.yml", import.meta.url), "utf8");
const docsJob = workflow.match(/^  validate-docs:\n([\s\S]*?)(?=^  den-contract:)/m)?.[1];
const modified = (filename) => ({ filename, status: "modified" });
const pr = (paths) => classifyCiChanges({ eventName: "pull_request", files: paths.map(modified), expectedCount: paths.length }, isBuildAffected);
const push = (paths) => classifyCiChanges({ eventName: "push", files: paths }, isBuildAffected);

for (const path of [".github/workflows/ci-tests.yml", ".github/scripts/classify-ci-changes.mjs", ".github/scripts/build-inputs.mjs"]) {
  test(`${path}: docs validation runs before merge as well as after`, () => {
    assert.equal(push([path]).docs, true);
    assert.equal(pr([path]).docs, true, "a docs-affecting PR must not first exercise validation on dev");
    assert.equal(pr([path]).core, true);
    assert.equal(pr([path]).desktop_smoke, true);
  });
}

test("mixed docs/product PRs retain the docs assertions alongside full product coverage", () => {
  const selected = pr(["packages/docs/slack/connect-slack.mdx", "ee/apps/den-api/src/routes/org/example.ts"]);
  assert.equal(selected.docs, true);
  assert.equal(selected.core, true);
  assert.equal(selected.desktop_smoke, true);
  assert.equal(selected.den_contract, true);
  assert.equal(pr(["ee/apps/landing/app/page.tsx"]).docs, false, "unrelated PRs do not acquire docs work");
});

test("both docs assertions use the verified Mint release without the crashing connectivity dependency", () => {
  assert.ok(docsJob);
  assert.match(docsJob, /MINT_VERSION: "4\.2\.1126"/);
  assert.match(docsJob, /pnpm\/action-setup@[a-f0-9]{40}/);
  assert.match(docsJob, /run: pnpm dlx "mint@\$MINT_VERSION" validate/);
  assert.match(docsJob, /run: pnpm dlx "mint@\$MINT_VERSION" broken-links/);
  assert.doesNotMatch(docsJob, /npx|mint@4\.2\.868|continue-on-error:|\|\|\s*true|--disable-openapi/);
  assert.match(workflow, /\.github\/scripts\/docs-validation\.test\.mjs/);
});
