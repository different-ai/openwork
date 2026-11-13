import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isBuildAffected } from "./build-inputs.mjs";
import { classifyCiChanges } from "./classify-ci-changes.mjs";

const workflow = readFileSync(new URL("../workflows/ci-tests.yml", import.meta.url), "utf8");
const docsJob = workflow.match(/^  validate-docs:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n)/m)?.[1];
const pr = (paths) => classifyCiChanges({ eventName: "pull_request", files: paths.map((filename) => ({ filename, status: "modified" })) }, isBuildAffected);

// Docs are validated on the PR that changes them ("Build and core checks").
for (const path of [".github/workflows/ci-tests.yml", ".github/scripts/classify-ci-changes.mjs", ".github/scripts/build-inputs.mjs", "packages/docs/guide.mdx", "packages/docs/docs.json"]) {
  test(`${path}: docs validation runs on the PR`, () => {
    assert.equal(pr([path]).docs, true);
  });
}

test("mixed docs/product PRs retain the docs assertions alongside product coverage", () => {
  const selected = pr(["packages/docs/slack/connect-slack.mdx", "ee/apps/den-api/src/routes/org/example.ts"]);
  assert.equal(selected.docs, true);
  assert.equal(selected.core, true);
  assert.equal(selected.den_api, true);
  assert.equal(pr(["ee/apps/landing/app/page.tsx"]).docs, false, "unrelated PRs do not acquire docs work");
});

test("both docs assertions use the verified Mint release without the crashing connectivity dependency", () => {
  assert.ok(docsJob);
  assert.match(docsJob, /MINT_VERSION: "4\.2\.1126"/);
  assert.match(docsJob, /pnpm\/action-setup@[a-f0-9]{40}/);
  assert.match(docsJob, /run: pnpm dlx "mint@\$MINT_VERSION" validate/);
  assert.match(docsJob, /run: pnpm dlx "mint@\$MINT_VERSION" broken-links/);
  assert.doesNotMatch(docsJob, /npx|mint@4\.2\.868|continue-on-error:|\|\|\s*true|--disable-openapi/);
  assert.match(readFileSync(new URL("../workflows/quick-check.yml", import.meta.url), "utf8"), /\.github\/scripts\/docs-validation\.test\.mjs/);
});
