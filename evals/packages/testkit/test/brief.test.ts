import assert from "node:assert/strict";
import test from "node:test";
import { claim, createBriefRun, testBrief } from "../src/brief.ts";

test("testBrief rejects invalid definitions", () => {
  assert.throws(() => testBrief({ behavior: "  ", claims: { valid: claim("works") } }), /behavior must not be empty/);
  assert.throws(() => testBrief({ behavior: "Works.", claims: {} }), /at least one claim/);
  assert.throws(() => testBrief({ behavior: "Works.", claims: { blankMust: claim("  ") } }), /blankMust.*blank must/);
  assert.throws(() => testBrief({ behavior: "Works.", claims: { blankNever: claim("works", { never: "  " }) } }), /blankNever.*blank never/);
});

test("a run records true proofs and reports its facts", () => {
  const recorded: { claimText: string; evidence: string; passed: boolean }[] = [];
  const brief = testBrief({
    behavior: "Two claims work.",
    claims: {
      first: claim("the first succeeds"),
      second: claim("the second succeeds", { never: "silently disappear" }),
    },
  });
  const run = createBriefRun(brief, (claimText, evidence, passed) => recorded.push({ claimText, evidence, passed }));

  run.prove.first(true, "first observed");
  run.prove.second(true, "second observed");

  assert.deepEqual(run.facts(), [
    { key: "first", passed: true, evidence: "first observed" },
    { key: "second", passed: true, evidence: "second observed" },
  ]);
  assert.doesNotThrow(() => run.assertAllProven());
  assert.equal(recorded[0].claimText, "first: the first succeeds");
  assert.equal(recorded[1].claimText, "second: the second succeeds — never: silently disappear");
});

test("a failed proof records before throwing", () => {
  const recorded: { passed: boolean }[] = [];
  const run = createBriefRun(testBrief({ behavior: "Failure is visible.", claims: { failure: claim("must pass") } }), (_claimText, _evidence, passed) => recorded.push({ passed }));

  assert.throws(() => run.prove.failure(false, "observed failure"), /Claim failed: failure/);
  assert.deepEqual(recorded, [{ passed: false }]);
});

test("blank proof evidence throws without recording", () => {
  const recorded: string[] = [];
  const run = createBriefRun(testBrief({ behavior: "Evidence is required.", claims: { evidenced: claim("has evidence") } }), (claimText) => recorded.push(claimText));

  assert.throws(() => run.prove.evidenced(true, "  "), /must not be blank/);
  assert.deepEqual(recorded, []);
});

test("assertAllProven names only the missing claim", () => {
  const run = createBriefRun(testBrief({
    behavior: "Every claim is required.",
    claims: { proven: claim("is proven"), missing: claim("is also proven") },
  }), () => {});
  run.prove.proven(true, "proven here");

  assert.throws(
    () => run.assertAllProven(),
    /^Error: Brief claims left unproven: missing\. Every declared claim needs a prove\.<claim>\(\) call\.$/,
  );
});
