import { strict as assert } from "node:assert";
import test from "node:test";

import {
  addedDiffLines,
  compact,
  formatReport,
  parseTerms,
  scanChange,
  scanSurface,
} from "./confidentiality-tripwire.mjs";

// Fixture terms are invented; nothing here names a real organization.
const terms = parseTerms("Globex Corp\nInitech\n#comment\nabc\n");

test("term parsing normalizes, dedupes, and drops too-short or commented entries", () => {
  assert.equal(terms.length, 2);
  assert.deepEqual(terms.map((term) => term.key), ["globexcorp", "initech"]);
  assert.equal(parseTerms("Initech,initech,INITECH").length, 1);
  assert.equal(parseTerms(undefined).length, 0);
  assert.equal(parseTerms("").length, 0);
});

test("matching survives casing, separators, diacritics, and URL encoding", () => {
  const variants = [
    "Globex Corp asked for this",
    "globex-corp/1-litellm",
    "globex_corp",
    "GLOBEXCORP",
    "Glóbex Çorp",
    "https://preview-git-globex%2Dcorp-x.vercel.app",
    "fix/globex+corp",
  ];
  for (const variant of variants) {
    const findings = scanSurface("s", [variant], { terms });
    assert.equal(findings.filter((finding) => finding.kind === "term").length, 1, variant);
  }
  assert.equal(compact("Glóbex-Çorp_ 2"), "globexcorp2");
});

test("clean text and unrelated names produce no term findings", () => {
  const findings = scanSurface("s", [
    "a custom OpenAI-compatible provider defined in the user-level opencode.json",
    "Acme Robotics demo seed",
    "fix(app): disconnect providers defined in config files",
  ], { terms });
  assert.deepEqual(findings, []);
});

test("findings never echo the confidential term or the matched line", () => {
  const findings = scanChange({
    branch: "globex-corp/1-litellm-disconnect",
    title: "fix for Initech",
    body: `Reported by Globex Corp via ${"#ext" + "-globex-openwork"} on 2026-09-02`,
    commits: ["fix: thing\n\nreported by Initech"],
  }, { terms });
  const report = formatReport(findings, { termCount: terms.length });
  for (const leak of ["globex", "Globex", "initech", "Initech", "ext-globex"]) {
    assert.equal(report.includes(leak), false, `report leaked ${leak}`);
  }
  assert.match(report, /branch name, line 1: confidential term #[0-9a-f]{8}/);
  assert.match(report, /PR title, line 1/);
  assert.match(report, /PR body, line 1: shared\/external Slack channel name/);
  assert.match(report, /commit message 1, line 3/);
  assert.match(report, /branch name cannot be scrubbed/);
});

test("structural checks catch emails and Slack links without a term list", () => {
  const findings = scanSurface("PR body", [
    // Assembled at runtime so this file's own source lines never trip the scanner.
    `contact: ${["someone", "customer-domain.example.co"].join("@")}`,
    `see https://acme-team.slack${".com/archives/"}C0123/p456`,
    "ok: bot@users.noreply.github.com",
    "ok: qa@example.com and test@fixture.test",
    "ok: support@openworklabs.com",
  ], { terms: [] });
  assert.deepEqual(findings.map((finding) => [finding.line, finding.kind]), [[1, "email"], [2, "slack"]]);
});

test("extra allowed email domains are honoured", () => {
  const findings = scanSurface("s", [["me", "partner.example.co"].join("@")], {
    terms: [],
    allowedEmailDomains: ["partner.example.co"],
  });
  assert.deepEqual(findings, []);
});

test("only added diff lines are scanned and lockfiles are ignored", () => {
  const diff = [
    "diff --git a/evals/specs/x.test.ts b/evals/specs/x.test.ts",
    "--- a/evals/specs/x.test.ts",
    "+++ b/evals/specs/x.test.ts",
    "@@ -1,2 +1,2 @@",
    "-// Initech report: old line being removed",
    "+// Field report: a config-file provider cannot be disconnected",
    "+// the Globex Corp case",
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "@@ -1 +1 @@",
    "+  resolution: {integrity: sha512-globexcorpAAAA}",
  ].join("\n");
  assert.equal(addedDiffLines(diff).length, 3);
  const findings = scanChange({ diff }, { terms });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].surface, "added lines in evals/specs/x.test.ts");
  assert.equal(findings[0].line, 2);
});

test("empty term list is reported so a missing secret is visible", () => {
  const report = formatReport([{ surface: "PR body", line: 1, kind: "email", detail: "email" }], { termCount: 0 });
  assert.match(report, /CONFIDENTIAL_TERMS was empty/);
  assert.equal(formatReport([], { termCount: 0 }), "confidentiality tripwire: clean");
});
