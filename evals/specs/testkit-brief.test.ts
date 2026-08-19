import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import { briefTest, claim, createBriefRun, test, testBrief } from "@openwork/testkit";

const testRunDirs: string[] = [];
let recordedDir = "";

function readEvidenceDir(evidence: unknown): string {
  if (typeof evidence !== "object" || evidence === null || !("dir" in evidence) || typeof evidence.dir !== "string") {
    throw new Error("Testkit evidence fixture did not expose a directory.");
  }
  return evidence.dir;
}

afterAll(async () => {
  await Promise.all(testRunDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

briefTest(testBrief({
  behavior: "A spec brief requires and records explicit proof for every declared claim.",
  claims: {
    claimRegistered: claim("declared claims expose matching proof functions", { never: "omit a declared proof entry" }),
    factsRecorded: claim("successful proof calls become passed ambient assertion evidence", { never: "leave successful claims unrecorded" }),
  },
}), ({ prove, evidence }) => {
  recordedDir = readEvidenceDir(evidence);
  testRunDirs.push(recordedDir);
  expect(Object.keys(prove)).toEqual(["claimRegistered", "factsRecorded"]);

  const missingRun = createBriefRun(testBrief({ behavior: "Missing proof fails.", claims: { missing: claim("is required") } }), () => {});
  expect(() => missingRun.assertAllProven()).toThrow("Brief claims left unproven: missing");

  const failedRecords: { passed: boolean; evidence: string }[] = [];
  const failedRun = createBriefRun(testBrief({ behavior: "Failed proof records.", claims: { failed: claim("must pass") } }), (_claimText, proofEvidence, passed) => {
    failedRecords.push({ passed, evidence: proofEvidence });
  });
  expect(() => failedRun.prove.failed(false, "the injected recorder observed the failed proof")).toThrow("Claim failed: failed");
  expect(failedRecords).toEqual([{ passed: false, evidence: "the injected recorder observed the failed proof" }]);

  prove.claimRegistered(true, "Object.keys(prove) matched both declared claim keys");
  prove.factsRecorded(true, "both successful prove calls completed against the ambient test evidence");
});

test("brief assertions are persisted on the preceding test evidence", async ({ evidence }) => {
  testRunDirs.push(evidence.dir);
  const value: unknown = JSON.parse(await readFile(join(recordedDir, "test-run.json"), "utf8"));
  expect(value).toMatchObject({
    summary: {
      ok: true,
      totalArtifacts: 2,
      passedArtifacts: 2,
      passedExpectations: 2,
      failedExpectations: 0,
    },
    artifacts: [
      {
        caption: "claimRegistered: declared claims expose matching proof functions — never: omit a declared proof entry",
        ok: true,
        description: "Object.keys(prove) matched both declared claim keys",
        judgments: [{ state: "passed", reasoning: "Object.keys(prove) matched both declared claim keys" }],
      },
      {
        caption: "factsRecorded: successful proof calls become passed ambient assertion evidence — never: leave successful claims unrecorded",
        ok: true,
        description: "both successful prove calls completed against the ambient test evidence",
        judgments: [{ state: "passed", reasoning: "both successful prove calls completed against the ambient test evidence" }],
      },
    ],
  });
});
