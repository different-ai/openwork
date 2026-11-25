import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const workflow = readFileSync(new URL("../workflows/ci-tests.yml", import.meta.url), "utf8");
const docsJob = workflow.match(/^  validate-docs:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/m)?.[1];

// Docs are validated nightly ("Nightly regression"), not on PRs or dev pushes.
test("both docs assertions use the verified Mint release without the crashing connectivity dependency", () => {
  assert.ok(docsJob);
  assert.match(docsJob, /MINT_VERSION: "4\.2\.1126"/);
  assert.match(docsJob, /pnpm\/action-setup@[a-f0-9]{40}/);
  assert.match(docsJob, /run: pnpm dlx "mint@\$MINT_VERSION" validate/);
  assert.match(docsJob, /run: pnpm dlx "mint@\$MINT_VERSION" broken-links/);
  assert.doesNotMatch(docsJob, /npx|mint@4\.2\.868|continue-on-error:|\|\|\s*true|--disable-openapi/);
  assert.match(readFileSync(new URL("../workflows/quick-check.yml", import.meta.url), "utf8"), /\.github\/scripts\/docs-validation\.test\.mjs/);
});
