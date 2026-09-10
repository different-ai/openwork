import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildChildEnvironment,
  consentVarsFromSource,
  exitCodeFor,
  parseArgs,
  resolveExecutionSelection,
  resolveRunEnvironment,
  resolveTestNames,
  summarize,
  summarizeSelectedCase,
  verdictFor,
  worldSnapshotsSince,
} from "./evals.mjs";
import { discoverWorlds, selectWorlds, planWorlds } from "../scripts/world-plan.ts";

const webSource = `import { spec } from "@openwork/testkit";
const test = spec.world(arrange, { resources: { surfaces: ["appWeb"], services: ["mock"] } });
test("CONT-01 streams", async () => {}); test("SWITCH-10 switches", async () => {});`;

test("AST selection isolates aliased worlds from curried legacy registrations and static prefixes", () => {
  const source = `import { spec as journey, test as legacy } from "@openwork/testkit";
    const browser = journey.world(browserWorld, { resources: { surfaces: ["appWeb"], services: ["mock"] } });
    const alias = browser;
    alias("SWITCH-10 switches", async () => {});
    const native = journey.world(nativeWorld, { resources: { surfaces: ["desktop"], services: [], nativeReason: "OS menus" } });
    native("NATIVE-01 menus", async () => {});
    legacy.skipIf(!runnable)(\`a tool started while away\${skipSuffix}\`, async () => {});`;
  const worlds = discoverWorlds("mixed.ts", source);
  assert.equal(worlds.length, 3);
  assert.equal(worlds.find(world => world.binding === "legacy").dynamicTitles, false);
  assert.deepEqual(selectWorlds(worlds, "^SWITCH-10(?:\\s|$)", "SWITCH-10").map(world => world.binding), ["browser"]);
  assert.deepEqual(selectWorlds(worlds, "^SWITCH-10(?:\\s|$)").map(world => world.binding), ["browser"]);
  const plan = planWorlds(["mixed.ts"], { sources: [source], pattern: "^SWITCH-10(?:\\s|$)", casePrefix: "SWITCH-10", surface: "web" });
  assert.deepEqual(plan.surfaces, ["appWeb"]);
  assert.deepEqual(plan.services, ["mock"]);
  assert.deepEqual(plan.legacy, []);
  assert.throws(() => planWorlds(["mixed.ts"], { sources: [source], surface: "web" }), /conflicts|legacy\/unresolved/);
  const unresolved = source + 'legacy(titleFromRuntime, async () => {});';
  assert.throws(() => planWorlds(["mixed.ts"], { sources: [unresolved], pattern: "^SWITCH-10", casePrefix: "SWITCH-10", surface: "web" }), /legacy\/unresolved/);
  assert.throws(() => discoverWorlds("bad.ts", webSource.replace('services: ["mock"]', '...shared')), /Spread/);
  assert.throws(() => discoverWorlds("bad.ts", webSource.replace('["appWeb"]', 'surfaces')), /literal arrays/);
  assert.equal(discoverWorlds("properties.ts", webSource + '/x/.test("text"); const object = { test: true };').length, 1);
  assert.throws(() => discoverWorlds("shadow.ts", webSource + 'function hidden(test) { test("hidden", () => {}); }'), /shadowed/);
  assert.throws(() => discoverWorlds("alias.ts", webSource + 'const hidden = test.skipIf(flag); hidden("hidden", () => {});'), /Configured test aliases/);
});

test("suite ancestry and each/for formatted titles stay conservatively selected", () => {
  for (const registration of [
    'describe("Group", () => test("leaf", async () => {}));',
    'describe(groupFromRuntime, () => test("leaf", async () => {}));',
    'suiteAlias("Group", () => test("leaf", async () => {}));',
    'test.each([["Group"]])("%s leaf", async () => {});',
    'test.for([{ group: "Group" }])("$group leaf", async () => {});',
    'test.each`group | value\n${"Group"} | ${1}`("$group leaf", async () => {});',
  ]) {
    const source = `import { test } from "@openwork/testkit"; ${registration}`;
    const worlds = discoverWorlds("group.ts", source);
    assert.equal(worlds[0].binding, "test", registration);
    assert.equal(selectWorlds(worlds, "^Group").length, 1, registration);
    assert.equal(worlds[0].dynamicTitles, true, registration);
    assert.throws(() => planWorlds(["group.ts"], { sources: [source], pattern: "^Group", surface: "web" }), /legacy\/unresolved/);
  }
  const exact = planWorlds(["exact.ts"], { sources: [webSource], pattern: "^SWITCH-10(?:\\s|$)", surface: "web" });
  assert.equal(exact.worlds.length, 1);
  assert.equal(exact.worlds[0].dynamicTitles, false);
});

test("grandfathered dynamic options stay unknown while explicit malformed resources fail", () => {
  const sourceWith = options => `import { spec } from "@openwork/testkit";
    const test = spec.world(arrange, ${options}); test("legacy", async () => {});`;
  for (const options of ['options', 'getOptions()', '{ ...options }', '{ timeout, ...options }', '{ [key]: value }', '{ resources: { surfaces: ["appWeb"], services: [] }, ...options }']) {
    const source = sourceWith(options);
    const plan = planWorlds(["legacy.ts"], { sources: [source] });
    assert.equal(plan.worlds[0].resources, null, options);
    assert.equal(plan.legacy.length, 1, options);
    assert.deepEqual(plan.surfaces, []);
    assert.deepEqual(plan.services, []);
    assert.throws(() => planWorlds(["legacy.ts"], { sources: [source], surface: "web" }), /legacy\/unresolved/);
  }
  for (const options of ['{ resources: config }', '{ resources }', '{ resources: { surfaces: ["appWeb"] }, ...options }', '{ ...options, resources: { surfaces: ["invalid"], services: [] } }']) {
    assert.throws(() => discoverWorlds("bad.ts", sourceWith(options)), /literal|Explicit resources|Unknown world surface/);
  }
});

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
    process.env.OPENWORK_EVAL_DAYTONA === "1";
    needs({ optIn: ["OPENWORK_EVAL_CHROME_HEADLESS"] });
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
  assert.throws(() => parseArgs(["--list", "--publish", "--pr", "42"]), /mutually exclusive/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown flag: --unknown/);
  assert.throws(() => parseArgs(["app-smoke", "--engine", "v3"]), /Invalid --engine/);
  assert.throws(() => parseArgs(["app-smoke", "--surface", "terminal"]), /Invalid --surface/);
  assert.equal(parseArgs(["app-smoke", "--surface", "web"]).surface, "web");
  assert.throws(() => parseArgs(["--case", "CONT-01"]), /requires exactly one named test/);
  assert.throws(() => parseArgs(["--list", "--engine", "v2"]), /--list is mutually exclusive/);
  assert.throws(() => parseArgs(["--publish", "--dry-run", "--engine", "v2"]), /mutually exclusive with --engine/);
});

test("registered cases validate file and effective engine/surface before placement", () => {
  const markdown = "/repo/streamed-markdown-answer.e2e.test.ts";
  const switched = "/repo/live-tool-visible-after-session-switch.e2e.test.ts";
  assert.throws(
    () => resolveExecutionSelection(parseArgs(["streamed-markdown-answer", "--case", "UNKNOWN"]), [markdown], {}),
    /Unknown --case/,
  );
  assert.throws(
    () => resolveExecutionSelection(parseArgs(["streamed-markdown-answer", "--case", "SWITCH-10"]), [markdown], {}),
    /belongs to live-tool-visible-after-session-switch/,
  );
  assert.throws(
    () => resolveExecutionSelection(parseArgs(["live-tool-visible-after-session-switch", "--surface", "electron", "--case", "SWITCH-10"]), [switched], {}, [webSource]),
    /conflicts with declared world surfaces/,
  );
  assert.throws(
    () => resolveExecutionSelection(parseArgs(["streamed-markdown-answer", "--case", "CONT-01"]), [markdown], { OPENWORK_EVAL_ENGINE: "future" }),
    /Invalid effective engine/,
  );
});

test("registered cases derive fixed web from source regardless of inherited surface", () => {
  const markdown = "/repo/streamed-markdown-answer.e2e.test.ts";
  const switched = "/repo/live-tool-visible-after-session-switch.e2e.test.ts";
  const defaultMarkdown = resolveExecutionSelection(
    parseArgs(["streamed-markdown-answer", "--case", "CONT-01"]),
    [markdown],
    {},
    [webSource],
  );
  const defaultSwitched = resolveExecutionSelection(
    parseArgs(["live-tool-visible-after-session-switch", "--case", "SWITCH-10"]),
    [switched],
    {},
    [webSource],
  );
  const inheritedElectron = resolveExecutionSelection(
    parseArgs(["streamed-markdown-answer", "--case", "CONT-01"]),
    [markdown],
    { OPENWORK_EVAL_APP_SURFACE: "electron" },
    [webSource],
  );

  assert.equal(defaultMarkdown.surface, "web");
  assert.equal(defaultMarkdown.env.OPENWORK_EVAL_APP_SURFACE, undefined);
  assert.equal(defaultSwitched.surface, "web");
  assert.equal(defaultSwitched.env.OPENWORK_EVAL_APP_SURFACE, undefined);
  assert.equal(inheritedElectron.surface, "web");
});

test("selection flags override inherited values without mutating the caller environment", () => {
  const env = {
    OPENWORK_EVAL_ENGINE: "v2",
    OPENWORK_ENGINE_V2_PREVIEW: "1",
    OPENWORK_EVAL_APP_SURFACE: "electron",
  };
  const before = { ...env };
  const selected = resolveExecutionSelection(
    parseArgs(["streamed-markdown-answer", "--engine", "v1", "--surface", "web", "--case", "CONT-01"]),
    ["/repo/streamed-markdown-answer.e2e.test.ts"],
    env,
    [webSource],
  );
  assert.deepEqual(env, before);
  assert.equal(selected.env.OPENWORK_EVAL_ENGINE, "v1");
  assert.equal(selected.env.OPENWORK_ENGINE_V2_PREVIEW, undefined);
  assert.equal(selected.env.OPENWORK_EVAL_APP_SURFACE, "web");
  assert.equal(selected.env.APP_SURFACE, undefined);
  assert.equal(selected.env.OPENWORK_EVAL_CHROME_HEADLESS, undefined);
  assert.equal(selected.env.OPENWORK_EVAL_E2E_TESTS, "1");
  assert.equal(selected.testNamePattern, "^CONT-01(?:\\s|$)");
  const child = buildChildEnvironment(
    parseArgs(["streamed-markdown-answer", "--local", "--surface", "web", "--case", "CONT-01"]),
    ["/repo/streamed-markdown-answer.e2e.test.ts"], [webSource], env,
    () => { throw new Error("local selection must not probe"); },
  );
  assert.equal(child.surface, "web");
  assert.equal(child.env.OPENWORK_EVAL_APP_SURFACE, "web");
  assert.equal(child.env.OPENWORK_EVAL_CHROME_HEADLESS, undefined);
  assert.deepEqual(env, before);
});

test("no selection flags preserve legacy engine and surface behavior", () => {
  const env = { OPENWORK_EVAL_ENGINE: "v2", OPENWORK_EVAL_APP_SURFACE: "web" };
  const selected = resolveExecutionSelection(parseArgs(["app-smoke"]), ["/repo/app-smoke.e2e.test.ts"], env, ['import { test } from "@openwork/testkit"; test("legacy", async () => {});']);
  assert.equal(selected.engine, undefined);
  assert.equal(selected.surface, undefined);
  assert.equal(selected.caseId, undefined);
  assert.deepEqual(selected.env, { ...env, OPENWORK_EVAL_E2E_TESTS: "1" });
});

test("--list prints exact registered cases and commands without selecting placement", () => {
  const result = spawnSync(process.execPath, [new URL("./evals.mjs", import.meta.url).pathname, "--list"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CONT-01  streamed-markdown-answer\.e2e\.test\.ts/);
  assert.match(result.stdout, /engines: v1, v2/);
  assert.match(result.stdout, /resources=unknown; legacy; lazy provision only/);
  assert.match(result.stdout, /pnpm evals:e2e streamed-markdown-answer --local --engine v2 --case CONT-01/);
  assert.match(result.stdout, /pnpm evals:e2e live-tool-visible-after-session-switch --daytona --engine v1 --case SWITCH-10/);
  assert.doesNotMatch(result.stdout, /--surface/);
  assert.doesNotMatch(result.stderr, /placement:/);
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
    OPENWORK_EVAL_ENGINE: "v2",
  }, () => { throw new Error("probe called"); });

  assert.deepEqual(resolved, { env: { PATH: "/bin", OPENWORK_EVAL_ENGINE: "v2", OPENWORK_WORLD_PLACE: "local" }, placement: "local", reason: "--local" });
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
      OPENWORK_WORLD_PLACE: "daytona",
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
    OPENWORK_EVAL_ENGINE: "v2",
  };
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), ambient, () => {
    throw new Error("probe called");
  }), {
    env: { ...ambient, OPENWORK_WORLD_PLACE: "daytona" },
    placement: "daytona",
    reason: "OPENWORK_EVAL_DAYTONA=1 in environment",
  });
});

test("automatic placement uses authenticated Daytona and otherwise falls back to local", () => {
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), { PATH: "/bin" }, () => true), {
    env: { PATH: "/bin", OPENWORK_EVAL_DAYTONA: "1", OPENWORK_WORLD_PLACE: "daytona" },
    placement: "daytona",
    reason: "daytona CLI authenticated",
  });
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), { PATH: "/bin" }, () => false), {
    env: { PATH: "/bin", OPENWORK_WORLD_PLACE: "local" },
    placement: "local",
    reason: "daytona CLI missing or not authenticated",
  });
});

test("canonical world placement overrides conflicting inherited selectors", () => {
  const local = resolveRunEnvironment(parseArgs(["app-smoke", "--local"]), {
    OPENWORK_WORLD_PLACE: "daytona",
    OPENWORK_EVAL_DAYTONA: "1",
  }, () => { throw new Error("probe called"); });
  assert.deepEqual(local, {
    env: { OPENWORK_WORLD_PLACE: "local" },
    placement: "local",
    reason: "--local",
  });

  const daytona = resolveRunEnvironment(parseArgs(["app-smoke", "--daytona"]), {
    OPENWORK_WORLD_PLACE: "local",
  }, () => true);
  assert.deepEqual(daytona, {
    env: { OPENWORK_WORLD_PLACE: "daytona", OPENWORK_EVAL_DAYTONA: "1" },
    placement: "daytona",
    reason: "--daytona",
  });

  const ambientLocal = resolveRunEnvironment(parseArgs(["app-smoke"]), {
    OPENWORK_WORLD_PLACE: "local",
    OPENWORK_EVAL_DAYTONA: "1",
  }, () => { throw new Error("probe called"); });
  assert.equal(ambientLocal.placement, "local");
  assert.equal(ambientLocal.env.OPENWORK_EVAL_DAYTONA, undefined);
});

test("final child environment cannot consent into a different placement", () => {
  const source = `
    process.env.OPENWORK_EVAL_E2E_TESTS === "1";
    process.env.OPENWORK_EVAL_DAYTONA === "1";
    process.env.OPENWORK_EVAL_LEGACY_LIVE === "1";
  `;
  const input = { OPENWORK_WORLD_PLACE: "daytona", OPENWORK_EVAL_DAYTONA: "1" };
  const local = buildChildEnvironment(
    parseArgs(["legacy", "--local"]),
    ["/repo/legacy.e2e.test.ts"],
    [source],
    input,
    () => { throw new Error("probe called"); },
  );
  assert.deepEqual(input, { OPENWORK_WORLD_PLACE: "daytona", OPENWORK_EVAL_DAYTONA: "1" });
  assert.equal(local.env.OPENWORK_WORLD_PLACE, "local");
  assert.equal(local.env.OPENWORK_EVAL_DAYTONA, undefined);
  assert.equal(local.env.OPENWORK_EVAL_LEGACY_LIVE, "1");

  const registered = buildChildEnvironment(
    parseArgs(["live-tool-visible-after-session-switch", "--local", "--engine", "v1", "--surface", "web", "--case", "SWITCH-10"]),
    ["/repo/live-tool-visible-after-session-switch.e2e.test.ts"],
    [webSource],
    {},
    () => { throw new Error("probe called"); },
  );
  assert.equal(registered.env.OPENWORK_WORLD_PLACE, "local");
  assert.equal(registered.env.OPENWORK_EVAL_DAYTONA, undefined);
  assert.equal(registered.env.OPENWORK_EVAL_LEGACY_LIVE, undefined);
  assert.deepEqual(registered.consented, ["OPENWORK_EVAL_E2E_TESTS"]);
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

test("selected-case summaries separate excluded titles and require an exact safe prefix", () => {
  const report = { testResults: [{
    name: "/repo/evals/specs/streamed-markdown-answer.e2e.test.ts",
    assertionResults: [
      { status: "passed", fullName: "CONT-01 streams markdown" },
      { status: "pending", fullName: "CONT-010 legacy lookalike" },
      { status: "pending", fullName: "CONT-01-extra legacy lookalike" },
      { status: "pending", fullName: "LEGACY skipped by name filter" },
    ],
  }] };
  assert.deepEqual(summarizeSelectedCase(report, "CONT-01"), {
    passed: 1,
    failed: 0,
    skipped: 0,
    skips: [],
    matched: 1,
    unhandled: 0,
    otherCasesNotRun: 3,
    unexpectedExecutions: 0,
    suiteErrors: 0,
  });
  assert.equal(verdictFor(summarizeSelectedCase(report, "CONT-01"), { requireMatch: true }), "passed");

  const skipped = summarizeSelectedCase({ testResults: [{ assertionResults: [{ status: "pending", title: "CONT-01 needs runtime" }] }] }, "CONT-01");
  assert.equal(verdictFor(skipped, { requireMatch: true }), "incomplete");
  const zeroMatches = summarizeSelectedCase({ testResults: [{ assertionResults: [{ status: "pending", title: "legacy filtered case" }] }] }, "SWITCH-10");
  assert.equal(verdictFor(zeroMatches, { requireMatch: true }), "incomplete");
  assert.equal(verdictFor(summarizeSelectedCase(undefined, "CONT-01"), { requireMatch: true, reportPresent: false }), "incomplete");
  assert.equal(verdictFor(summarizeSelectedCase(undefined, "CONT-01"), { childExit: 1, requireMatch: true, reportPresent: false }), "failed");
  assert.equal(verdictFor(summarizeSelectedCase(undefined, "CONT-01"), { childExit: false, requireMatch: true, reportPresent: false }), "failed");

  const unexpected = summarizeSelectedCase({ testResults: [{ assertionResults: [
    { status: "passed", title: "CONT-01 selected" },
    { status: "passed", title: "legacy case unexpectedly ran" },
  ] }] }, "CONT-01");
  assert.equal(unexpected.otherCasesNotRun, 0);
  assert.equal(unexpected.unexpectedExecutions, 1);
  assert.equal(verdictFor(unexpected, { requireMatch: true }), "failed");

  const unknownStatus = summarizeSelectedCase({ testResults: [{ assertionResults: [{ status: null, title: "CONT-01 selected" }] }] }, "CONT-01");
  assert.equal(unknownStatus.unhandled, 1);
  assert.equal(verdictFor(unknownStatus, { requireMatch: true }), "incomplete");

  const suiteError = summarizeSelectedCase({ numFailedTestSuites: 1, testResults: [] }, "CONT-01");
  assert.equal(verdictFor(suiteError, { requireMatch: true }), "failed");
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


test("scenario names and explicit paths resolve alongside legacy specs", () => {
  const scenario = new URL("../../scenarios/onboarding/e2e.test.ts", import.meta.url).pathname;
  const legacy = new URL("../specs/signup-workspace-intent.e2e.test.ts", import.meta.url).pathname;
  const files = [scenario, legacy];
  assert.deepEqual(resolveTestNames(["onboarding"], files), [scenario]);
  assert.deepEqual(resolveTestNames(["scenarios/onboarding/e2e.test.ts"], files), [scenario]);
  assert.deepEqual(resolveTestNames(["signup-workspace-intent"], files), [legacy]);
  assert.deepEqual(resolveTestNames(["onboarding", "scenarios/onboarding/e2e.test.ts"], files), [scenario]);
  assert.throws(() => resolveTestNames(["missing"], files), /No test matches/);
});
