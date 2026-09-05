import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  consentVarsFromSource,
  exitCodeFor,
  parseArgs,
  resolveRunEnvironment,
  resolveTestNames,
  summarize,
  verdictFor,
  worldSnapshotsSince,
} from "./evals.mjs";

test("consentVarsFromSource extracts, deduplicates, and sorts only opt-in variables", () => {
  const source = `
    needs({ optIn: ["OPENWORK_EVAL_ZETA", 'OPENWORK_EVAL_ALPHA'] });
    const requirements = {
      optIn: [
        "OPENWORK_EVAL_MULTI",
        "OPENWORK_EVAL_ALPHA",
      ],
    };
    process.env.OPENWORK_EVAL_DIRECT === "1";
    process.env.OPENWORK_EVAL_TRIMMED?.trim() === "1";
    process.env.OPENWORK_EVAL_MODEL?.trim() || "";
    process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
    process.env.UNRELATED === "1";
  `;

  assert.deepEqual(consentVarsFromSource(source), [
    "OPENWORK_EVAL_ALPHA",
    "OPENWORK_EVAL_DIRECT",
    "OPENWORK_EVAL_MULTI",
    "OPENWORK_EVAL_TRIMMED",
    "OPENWORK_EVAL_ZETA",
  ]);
});

test("parseArgs maps run and publish flags", () => {
  assert.deepEqual(parseArgs(["app-smoke", "--with-llm-vision", "--daytona", "--den", "https://den.example"]), {
    testNames: ["app-smoke"],
    withLlmVision: true,
    local: false,
    daytona: true,
    publish: false,
    dryRun: false,
    force: false,
    help: false,
    den: "https://den.example",
  });
  assert.deepEqual(parseArgs(["--publish", "--pr", "42", "--test-run", "latest", "--dry-run", "--force"]), {
    testNames: [],
    withLlmVision: false,
    local: false,
    daytona: false,
    publish: true,
    dryRun: true,
    force: true,
    help: false,
    pr: "42",
    testRun: "latest",
  });
});

test("parseArgs validates values, exclusivity, and unknown flags", () => {
  assert.throws(() => parseArgs(["--den"]), /--den requires a value/);
  assert.throws(() => parseArgs(["--publish", "--dry-run", "app-smoke"]), /mutually exclusive with test names/);
  assert.throws(() => parseArgs(["--publish", "--pr", "1", "--den", "x"]), /mutually exclusive with --den/);
  assert.throws(() => parseArgs(["app-smoke", "--local", "--daytona"]), /--local is mutually exclusive with --daytona/);
  assert.throws(() => parseArgs(["app-smoke", "--local", "--den", "https:\/\/den.example"]), /--local is mutually exclusive with --den/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown flag: --unknown/);
});

test("explicit local placement removes inherited remote provisioning inputs", () => {
  const options = parseArgs(["app-smoke", "--local"]);
  const resolved = resolveRunEnvironment(options, {
    PATH: "/bin",
    OPENWORK_EVAL_DAYTONA: "1",
    OPENWORK_EVAL_DAYTONA_SANDBOX: "desktop-sandbox",
    OPENWORK_EVAL_DAYTONA_SANDBOX_ID: "legacy-sandbox",
    OPENWORK_EVAL_DAYTONA_DEN_SANDBOX: "den-sandbox",
    OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX: "prepared-desktop",
    OPENWORK_EVAL_DEN_API_URL: "https://den-api.example.test",
    OPENWORK_EVAL_DEN_WEB_URL: "https://den.example.test",
  }, () => { throw new Error("probe called"); });

  assert.deepEqual(resolved, { env: { PATH: "/bin" }, placement: "local", reason: "--local" });
});

test("explicit attached Den placement does not probe Daytona", () => {
  const attached = resolveRunEnvironment(parseArgs(["app-smoke", "--den", "https://den.example.test"]), {}, () => {
    throw new Error("probe called");
  });
  assert.deepEqual(attached, {
    env: { OPENWORK_EVAL_DEN_API_URL: "https://den.example.test" },
    placement: "attached",
    reason: "--den",
  });
});

test("explicit Daytona placement requires an authenticated CLI", () => {
  const daytona = resolveRunEnvironment(parseArgs(["app-smoke", "--daytona"]), {
    OPENWORK_EVAL_DEN_API_URL: "https://attached.example.test",
  }, () => true);
  assert.deepEqual(daytona, {
    env: {
      OPENWORK_EVAL_DEN_API_URL: "https://attached.example.test",
      OPENWORK_EVAL_DAYTONA: "1",
    },
    placement: "daytona",
    reason: "--daytona",
  });

  assert.throws(
    () => resolveRunEnvironment(parseArgs(["app-smoke", "--daytona"]), {}, () => false),
    /--daytona requested but the daytona CLI is missing or not authenticated/,
  );
});

test("ambient Daytona placement preserves the caller environment without probing", () => {
  const ambient = {
    OPENWORK_EVAL_DAYTONA: "1",
    OPENWORK_EVAL_DEN_API_URL: "https://den.example.test",
  };
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), ambient, () => {
    throw new Error("probe called");
  }), {
    env: ambient,
    placement: "daytona",
    reason: "OPENWORK_EVAL_DAYTONA=1 in environment",
  });
});

test("automatic placement uses authenticated Daytona and otherwise falls back to local", () => {
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), { PATH: "/bin" }, () => true), {
    env: { PATH: "/bin", OPENWORK_EVAL_DAYTONA: "1" },
    placement: "daytona",
    reason: "daytona CLI authenticated",
  });
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), { PATH: "/bin" }, () => false), {
    env: { PATH: "/bin" },
    placement: "local",
    reason: "daytona CLI missing or not authenticated",
  });
});

test("verdict and exit mapping covers failed, incomplete, and passed runs", () => {
  const failed = verdictFor({ failed: 1, skipped: 0 });
  assert.equal(failed, "failed");
  assert.equal(exitCodeFor(failed, { named: true }), 1);

  const incomplete = verdictFor({ failed: 0, skipped: 1 });
  assert.equal(incomplete, "incomplete");
  assert.equal(exitCodeFor(incomplete, { named: true }), 2);
  assert.equal(exitCodeFor(incomplete, { named: false }), 0);

  const passed = verdictFor({ failed: 0, skipped: 0 });
  assert.equal(passed, "passed");
  assert.equal(exitCodeFor(passed, { named: true }), 0);
});

test("summarize reads counts and skipped test details", () => {
  assert.deepEqual(summarize({
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    testResults: [{
      name: "/repo/evals/specs/app-smoke.e2e.test.ts",
      assertionResults: [
        { status: "passed", title: "runs" },
        { status: "pending", title: "needs provider" },
      ],
    }],
  }), {
    passed: 1,
    failed: 0,
    skipped: 1,
    skips: [{ file: "app-smoke.e2e.test.ts", title: "needs provider" }],
  });
});

test("worldSnapshotsSince returns only snapshots written during the run, newest first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-world-snapshots-"));
  try {
    await writeFile(join(directory, "old.json"), "{}\n");
    await utimes(join(directory, "old.json"), new Date(0), new Date(0));
    const startTime = Date.now();
    await writeFile(join(directory, "recent.json"), "{}\n");
    await writeFile(join(directory, "newer.json"), "{}\n");
    await utimes(join(directory, "recent.json"), new Date(startTime + 1_000), new Date(startTime + 1_000));
    await utimes(join(directory, "newer.json"), new Date(startTime + 2_000), new Date(startTime + 2_000));
    await writeFile(join(directory, "ignored.txt"), "not a snapshot\n");

    assert.deepEqual(worldSnapshotsSince(startTime, directory), [
      join(directory, "newer.json"),
      join(directory, "recent.json"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
