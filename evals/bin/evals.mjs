#!/usr/bin/env node
import { journeyFiles, testName } from "./test-files.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registeredCases } from "../scripts/journey-catalog.mjs";
import { discoverWorlds, planWorlds, worldContract } from "../scripts/world-plan.ts";

const evalsDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const worldsDir = join(evalsDir, "results/.worlds");

function caseCommand(value) {
  return `pnpm evals:e2e ${value.spec.replace(".e2e.test.ts", "")} ${value.example.placement} --engine ${value.example.engine} --case ${value.id}`;
}

const caseExamples = registeredCases.map(caseCommand).join("\n");

const usage = `Usage: node evals/bin/evals.mjs [test-names...] [flags]

Run E2E tests:
  --with-llm-vision  Judge vision claims inline (default: defer judging)
  --local            Force isolated local resources and clear inherited remote placement
  --daytona          Require Daytona (fails if the CLI is not authenticated)
  --den <url>        Set OPENWORK_EVAL_DEN_API_URL=<url>
  --engine <v1|v2>   Select the app chat engine for a named test
  --surface <value>  Validate declared app surface (web|electron); never switches implementation
  --case <prefix>    Run one registered case by its exact prefix

Without a placement flag, Daytona is used when the daytona CLI is authenticated, otherwise local.

Publish recorded evidence (no test reruns or model calls):
  --publish         Publish completed evidence
  --pr <n>          Publish to pull request n
  --test-run <value> Select a test run path, directory ID, name, or latest (default: latest)
  --all             Combine all runs matching the current PR head
  --docshot <path>  Include a DocShot .review.json receipt (repeatable)
  --title <text>    Report title (defaults to Change verification)
  --gap <text>      Declare a coverage gap (repeatable)
  --review-url <url> Override OPENWORK_REVIEW_URL
  --dry-run         Render publication output without posting
  --force           Forward force to the publisher

Other:
  --list            List tests, registered cases, and copyable commands without booting
  --help, -h        Show this help

Publish mode cannot be combined with test names, run-selection flags, --with-llm-vision,
--daytona, --local, or --den. Named tests auto-consent to opt-in flags declared in their source;
value-bearing environment variables are never auto-set.

Registered case examples:
${caseExamples}

Run exit codes:
  0  Passed, or an unfiltered E2E suite completed with expected skips
  1  One or more tests failed
  2  A named test skipped and its result is incomplete

Publish exit codes:
  0  Publisher succeeded
  1  Publication failed
  Visual judgments retain their recorded passed, failed, or pending state.
`;

export function consentVarsFromSource(text) {
  const variables = new Set();
  const optInPattern = /optIn\s*:\s*\[([^\]]*)\]/gs;
  const envPattern = /process\.env\.(OPENWORK_EVAL_[A-Z0-9_]+)(?:\?\.trim\(\))?\s*===\s*"1"/g;

  for (const match of text.matchAll(optInPattern)) {
    for (const literal of match[1].matchAll(/["'](OPENWORK_EVAL_[A-Z0-9_]+)["']/g)) {
      variables.add(literal[1]);
    }
  }
  for (const match of text.matchAll(envPattern)) variables.add(match[1]);

  return [...variables].filter(variable => !TRANSPORT_SELECTOR_ENV.has(variable)).sort();
}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args) {
  const options = {
    testNames: [],
    withLlmVision: false,
    local: false,
    daytona: false,
    publish: false,
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--with-llm-vision") options.withLlmVision = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--daytona") options.daytona = true;
    else if (arg === "--publish") options.publish = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (["--engine", "--surface", "--case"].includes(arg)) {
      const value = valueAfter(args, index, arg);
      if (arg === "--engine") options.engine = value;
      else if (arg === "--surface") options.surface = value;
      else options.case = value;
      index += 1;
    }
    else if (arg === "--all") (options.reviewArgs ??= []).push(arg);
    else if (["--docshot", "--title", "--gap", "--review-url"].includes(arg)) {
      (options.reviewArgs ??= []).push(arg, valueAfter(args, index, arg));
      index += 1;
    }
    else if (arg === "--den" || arg === "--pr" || arg === "--test-run") {
      const value = valueAfter(args, index, arg);
      if (arg === "--den") options.den = value;
      else if (arg === "--pr") options.pr = value;
      else if (options.testRun !== undefined) (options.reviewArgs ??= []).push("--test-run", value);
      else options.testRun = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      options.testNames.push(arg);
    }
  }

  if (options.local && (options.daytona || options.den !== undefined)) {
    const conflicts = [];
    if (options.daytona) conflicts.push("--daytona");
    if (options.den !== undefined) conflicts.push("--den");
    throw new Error(`--local is mutually exclusive with ${conflicts.join(" and ")}.`);
  }

  if (options.engine !== undefined && !["v1", "v2"].includes(options.engine)) {
    throw new Error(`Invalid --engine ${JSON.stringify(options.engine)}; expected v1 or v2.`);
  }
  if (options.surface !== undefined && !["web", "electron"].includes(options.surface)) {
    throw new Error(`Invalid --surface ${JSON.stringify(options.surface)}; expected web or electron.`);
  }
  if (!options.publish && (options.engine !== undefined || options.surface !== undefined) && options.testNames.length === 0 && !options.list) {
    throw new Error("--engine and --surface require a named test.");
  }
  if (!options.publish && options.case !== undefined && options.testNames.length === 0) {
    throw new Error("--case requires exactly one named test.");
  }
  if (options.list && (options.engine !== undefined || options.surface !== undefined || options.case !== undefined)) {
    throw new Error("--list is mutually exclusive with --engine, --surface, and --case.");
  }

  if (options.publish) {
    const conflicts = [];
    if (options.list) conflicts.push("--list");
    if (options.testNames.length > 0) conflicts.push("test names");
    if (options.withLlmVision) conflicts.push("--with-llm-vision");
    if (options.local) conflicts.push("--local");
    if (options.daytona) conflicts.push("--daytona");
    if (options.den !== undefined) conflicts.push("--den");
    if (options.engine !== undefined) conflicts.push("--engine");
    if (options.surface !== undefined) conflicts.push("--surface");
    if (options.case !== undefined) conflicts.push("--case");
    if (conflicts.length > 0) {
      throw new Error(`--publish is mutually exclusive with ${conflicts.join(", ")}.`);
    }
    if (!options.pr && !options.dryRun && !options.help) {
      throw new Error("--pr <n> is required unless --dry-run is set.");
    }
  } else {
    const publishFlags = [];
    if (options.pr !== undefined) publishFlags.push("--pr");
    if (options.testRun !== undefined) publishFlags.push("--test-run");
    if (options.dryRun) publishFlags.push("--dry-run");
    if (options.force) publishFlags.push("--force");
    if (options.reviewArgs) publishFlags.push("review options");
    if (publishFlags.length > 0) {
      throw new Error(`${publishFlags.join(", ")} require --publish.`);
    }
  }

  return options;
}

// The complete caller environment, including OPENWORK_EVAL_ENGINE, is passed
// through below. Only these remote-placement inputs are removed by --local.
const REMOTE_PLACEMENT_ENV = [
  "OPENWORK_WORLD_PLACE",
  "OPENWORK_EVAL_DAYTONA",
  "OPENWORK_EVAL_DAYTONA_SANDBOX",
  "OPENWORK_EVAL_DAYTONA_SANDBOX_ID",
  "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX",
  "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX",
  "OPENWORK_EVAL_DEN_API_URL",
  "OPENWORK_EVAL_DEN_WEB_URL",
];

const TRANSPORT_SELECTOR_ENV = new Set([
  "OPENWORK_EVAL_DAYTONA",
  "OPENWORK_EVAL_DAYTONA_SANDBOX",
  "OPENWORK_EVAL_DAYTONA_SANDBOX_ID",
  "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX",
  "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX",
  "OPENWORK_EVAL_DEN_API_URL",
  "OPENWORK_EVAL_DEN_WEB_URL",
  "OPENWORK_EVAL_REF",
  "OPENWORK_EVAL_ENGINE",
  "OPENWORK_EVAL_APP_SURFACE",
  "OPENWORK_EVAL_CHROME_HEADLESS",
]);

/** Resolve the child environment before any test process can provision resources. */
export function daytonaAuthenticated(exec = spawnSync) {
  const result = exec("daytona", ["snapshot", "list", "-f", "json"], {
    stdio: "ignore",
    timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

export function resolveRunEnvironment(options, env = process.env, probe = daytonaAuthenticated) {
  const childEnv = { ...env };
  const worldPlace = env.OPENWORK_WORLD_PLACE?.trim() || undefined;
  if (options.local) {
    for (const name of REMOTE_PLACEMENT_ENV) delete childEnv[name];
    childEnv.OPENWORK_WORLD_PLACE = "local";
    return { env: childEnv, placement: "local", reason: "--local" };
  }
  if (options.den !== undefined) {
    childEnv.OPENWORK_EVAL_DEN_API_URL = options.den;
    return { env: childEnv, placement: "attached", reason: "--den" };
  }
  if (options.daytona) {
    if (!probe()) {
      throw new Error("--daytona requested but the daytona CLI is missing or not authenticated. Install it and run `daytona login`.");
    }
    childEnv.OPENWORK_EVAL_DAYTONA = "1";
    childEnv.OPENWORK_WORLD_PLACE = "daytona";
    return { env: childEnv, placement: "daytona", reason: "--daytona" };
  }
  if (worldPlace === "daytona") {
    childEnv.OPENWORK_EVAL_DAYTONA = "1";
    return { env: childEnv, placement: "daytona", reason: "OPENWORK_WORLD_PLACE=daytona in environment" };
  }
  if (worldPlace !== undefined) {
    delete childEnv.OPENWORK_EVAL_DAYTONA;
    return { env: childEnv, placement: "local", reason: `OPENWORK_WORLD_PLACE=${worldPlace} in environment` };
  }
  if (env.OPENWORK_EVAL_DAYTONA?.trim() === "1") {
    childEnv.OPENWORK_WORLD_PLACE = "daytona";
    return { env: childEnv, placement: "daytona", reason: "OPENWORK_EVAL_DAYTONA=1 in environment" };
  }
  if (probe()) {
    childEnv.OPENWORK_EVAL_DAYTONA = "1";
    childEnv.OPENWORK_WORLD_PLACE = "daytona";
    return { env: childEnv, placement: "daytona", reason: "daytona CLI authenticated" };
  }
  childEnv.OPENWORK_WORLD_PLACE = "local";
  return { env: childEnv, placement: "local", reason: "daytona CLI missing or not authenticated" };
}

export function resolveTestNames(names, files = journeyFiles()) {
  const entries = files.map((file) => ({
    file,
    base: basename(file),
    relative: testName(file),
  }));
  const resolved = [];

  for (const name of names) {
    const normalized = name.replace(/^\.\//, "").replace(/^specs\//, "");
    let matches = entries.filter((entry) => entry.relative === normalized);
    if (matches.length === 0) {
      matches = entries.filter((entry) => entry.relative === `scenarios/${normalized}/e2e.test.ts`);
    }
    if (matches.length === 0) {
      matches = entries.filter((entry) =>
        entry.base === `${normalized}.e2e.test.ts`
      );
    }
    if (matches.length === 0) {
      matches = entries.filter((entry) => entry.base.startsWith(normalized));
    }
    if (matches.length > 1) {
      throw new Error(`Test name "${name}" is ambiguous:\n${matches.map((entry) => `  ${entry.relative}`).join("\n")}`);
    }
    if (matches.length === 0) {
      const close = entries.filter((entry) => entry.base.includes(normalized));
      throw new Error(`No test matches "${name}". Close candidates:\n${close.length > 0 ? close.map((entry) => `  ${entry.relative}`).join("\n") : "  (none)"}`);
    }
    if (!resolved.includes(matches[0].file)) resolved.push(matches[0].file);
  }

  return resolved;
}

function literalPrefixPattern(value) {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`;
}

export function resolveExecutionSelection(options, resolved, env = process.env, sources) {
  const childEnv = { ...env, OPENWORK_EVAL_E2E_TESTS: "1" };
  let selectedCase;
  if (options.case !== undefined) {
    if (resolved.length !== 1) throw new Error("--case requires exactly one resolved test file.");
    const spec = basename(resolved[0]);
    selectedCase = registeredCases.find(value => value.id === options.case && value.spec === spec);
    if (!selectedCase) {
      const known = registeredCases.find(value => value.id === options.case);
      if (known) throw new Error(`--case ${options.case} belongs to ${known.spec}, not ${spec}.`);
      throw new Error(`Unknown --case ${JSON.stringify(options.case)}.`);
    }
  }

  const engine = options.engine ?? (selectedCase ? (env.OPENWORK_EVAL_ENGINE || "v1").toLowerCase() : undefined);
  if (selectedCase && !["v1", "v2"].includes(engine)) {
    throw new Error(`Invalid effective engine ${JSON.stringify(engine)}; expected v1 or v2.`);
  }
  if (selectedCase && !selectedCase.engines.includes(engine)) {
    throw new Error(`--case ${selectedCase.id} does not support engine ${engine}.`);
  }
  const testNamePattern = selectedCase ? literalPrefixPattern(selectedCase.id) : undefined;
  const plan = planWorlds(resolved, { pattern: testNamePattern, casePrefix: selectedCase?.id, surface: options.surface, sources });
  const surface = plan.legacy.length ? undefined : plan.surfaces.includes("appWeb") && !plan.surfaces.includes("desktop") ? "web" : plan.surfaces.includes("desktop") && !plan.surfaces.includes("appWeb") ? "electron" : undefined;

  if (engine !== undefined) childEnv.OPENWORK_EVAL_ENGINE = engine;
  if (engine !== undefined) delete childEnv.OPENWORK_ENGINE_V2_PREVIEW;
  if (options.surface !== undefined) childEnv.OPENWORK_EVAL_APP_SURFACE = options.surface;
  return {
    env: childEnv,
    engine,
    surface,
    caseId: selectedCase?.id,
    optIns: selectedCase?.optIns,
    testNamePattern,
    plan,
  };
}

export function buildChildEnvironment(options, resolved, sources, env = process.env, probe = daytonaAuthenticated) {
  const selection = resolveExecutionSelection(options, resolved, env, sources);
  const placement = resolveRunEnvironment(options, selection.env, probe);
  const childEnv = { ...placement.env };
  const consented = new Set(["OPENWORK_EVAL_E2E_TESTS"]);
  const requested = selection.optIns ?? sources.flatMap(consentVarsFromSource);
  for (const variable of requested) {
    if (TRANSPORT_SELECTOR_ENV.has(variable) || Object.hasOwn(env, variable)) continue;
    childEnv[variable] = "1";
    consented.add(variable);
  }

  // Consent can never override the already-resolved runtime placement.
  if (placement.placement === "local") {
    delete childEnv.OPENWORK_EVAL_DAYTONA;
    childEnv.OPENWORK_WORLD_PLACE = "local";
  } else if (placement.placement === "daytona") {
    childEnv.OPENWORK_EVAL_DAYTONA = "1";
    childEnv.OPENWORK_WORLD_PLACE = "daytona";
  }
  return { ...selection, ...placement, env: childEnv, consented: [...consented].sort() };
}

function reportAssertions(report) {
  if (!Array.isArray(report?.testResults)) return [];
  return report.testResults.flatMap((result) => {
    if (!Array.isArray(result?.assertionResults)) return [];
    return result.assertionResults.map((assertion) => ({ assertion, result }));
  });
}

function reportCount(report, field, status) {
  if (Number.isFinite(report?.[field])) return report[field];
  const assertions = reportAssertions(report);
  if (assertions.length === 0) return null;
  return assertions.filter(({ assertion }) => status.includes(assertion?.status)).length;
}

export function summarize(report) {
  const assertions = reportAssertions(report);
  return {
    passed: reportCount(report, "numPassedTests", ["passed"]),
    failed: reportCount(report, "numFailedTests", ["failed"]),
    skipped: reportCount(report, "numPendingTests", ["pending", "skipped", "todo", "disabled"]),
    skips: assertions
      .filter(({ assertion }) => ["pending", "skipped", "todo", "disabled"].includes(assertion?.status))
      .map(({ assertion, result }) => ({
        file: basename(result?.name ?? result?.testFilePath ?? "unknown"),
        title: assertion?.title ?? assertion?.fullName ?? "unknown",
      })),
  };
}

export function summarizeSelectedCase(report, caseId) {
  if (!report || !caseId) return { passed: null, failed: null, skipped: null, skips: [], matched: 0, unhandled: 0, otherCasesNotRun: 0, unexpectedExecutions: 0, suiteErrors: 0 };
  const pattern = new RegExp(literalPrefixPattern(caseId));
  const assertions = reportAssertions(report);
  const selected = assertions.filter(({ assertion }) =>
    pattern.test(assertion?.title ?? "") || pattern.test(assertion?.fullName ?? "")
  );
  const skippedStatuses = ["pending", "skipped", "todo", "disabled"];
  const excluded = assertions.filter(value => !selected.includes(value));
  const passed = selected.filter(({ assertion }) => assertion?.status === "passed").length;
  const failed = selected.filter(({ assertion }) => assertion?.status === "failed").length;
  const skipped = selected.filter(({ assertion }) => skippedStatuses.includes(assertion?.status)).length;
  return {
    passed,
    failed,
    skipped,
    skips: selected.filter(({ assertion }) => skippedStatuses.includes(assertion?.status)).map(({ assertion, result }) => ({
      file: basename(result?.name ?? result?.testFilePath ?? "unknown"),
      title: assertion?.title ?? assertion?.fullName ?? "unknown",
    })),
    matched: selected.length,
    unhandled: selected.length - passed - failed - skipped,
    otherCasesNotRun: excluded.filter(({ assertion }) => skippedStatuses.includes(assertion?.status)).length,
    unexpectedExecutions: excluded.filter(({ assertion }) => !skippedStatuses.includes(assertion?.status)).length,
    suiteErrors: Number.isFinite(report.numFailedTestSuites)
      ? report.numFailedTestSuites
      : (Array.isArray(report.testResults) ? report.testResults : []).filter(result => result?.status === "failed" || result?.failureMessage).length,
  };
}

export function verdictFor(summary, { childExit = 0, requireMatch = false, reportPresent = true } = {}) {
  if ((summary.failed ?? 0) > 0 || (summary.unexpectedExecutions ?? 0) > 0 || (summary.suiteErrors ?? 0) > 0 || childExit !== 0) return "failed";
  if (!reportPresent || (requireMatch && summary.matched === 0) || (summary.unhandled ?? 0) > 0) return "incomplete";
  if ((summary.skipped ?? 0) > 0) return "incomplete";
  return "passed";
}

export function exitCodeFor(verdict, { named = false } = {}) {
  if (verdict === "failed") return 1;
  if (verdict === "incomplete" && named) return 2;
  return 0;
}

export function worldSnapshotsSince(startTime, directory = worldsDir) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try {
          const path = join(directory, entry.name);
          const mtime = statSync(path).mtimeMs;
          return mtime >= startTime ? [{ path, mtime }] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.mtime - left.mtime)
      .map(({ path }) => path);
  } catch {
    return [];
  }
}

function childStatus(result) {
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  return result.status ?? 1;
}

function publish(options) {
  const publishArgs = [join(evalsDir, "packages/test-artifacts/bin/publish-pr.mjs")];
  if (options.pr) publishArgs.push("--pr", options.pr);
  if (options.testRun) publishArgs.push("--test-run", options.testRun);
  if (options.dryRun) publishArgs.push("--dry-run");
  if (options.force) publishArgs.push("--force");
  if (options.reviewArgs) publishArgs.push(...options.reviewArgs);
  const published = spawnSync(process.execPath, publishArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  const publishStatus = childStatus(published);
  return publishStatus;
}

function run(options) {
  const runStartedAt = Date.now();
  const resolved = options.testNames.length ? resolveTestNames(options.testNames) : journeyFiles();
  const sources = resolved.map(file => readFileSync(file, "utf8"));
  const selection = buildChildEnvironment(options, resolved, sources);
  const { env: childEnv, placement, reason, consented } = selection;
  if (options.withLlmVision) delete childEnv.OPENWORK_EVAL_VISION;
  else childEnv.OPENWORK_EVAL_VISION = "defer";
  const outputDir = join(evalsDir, "results/.testkit");
  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, `cli-run-${Date.now()}.json`);
  const vitestArgs = [
    "exec", "vitest", "run",
    "--config", "vitest.config.ts",
    "--project", "e2e",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...(selection.testNamePattern ? ["--testNamePattern", selection.testNamePattern] : []),
    ...resolved.map((file) => relative(evalsDir, file).split(sep).join("/")),
  ];
  process.stderr.write(`selection: engine=${selection.engine ?? "legacy"} surface=${selection.surface ?? "legacy"} case=${selection.caseId ?? "all"}; placement: ${placement} (${reason})\n`);
  for (const world of selection.plan.worlds) process.stderr.write(`contract: ${testName(world.file)}:${world.line} ${worldContract(world)}\n`);
  const child = spawnSync("pnpm", vitestArgs, { cwd: evalsDir, env: childEnv, stdio: "inherit" });
  const status = childStatus(child);
  let report;
  try {
    const parsed = JSON.parse(readFileSync(outputFile, "utf8"));
    if (!Number.isFinite(parsed?.numTotalTests) || !Array.isArray(parsed?.testResults)) {
      throw new Error("Invalid Vitest JSON report.");
    }
    report = parsed;
  } catch {
    report = undefined;
  }
  const summary = selection.caseId ? summarizeSelectedCase(report, selection.caseId) : summarize(report);
  const verdict = verdictFor(summary, { childExit: status, requireMatch: Boolean(selection.caseId), reportPresent: Boolean(report) });
  if (verdict === "failed") {
    const snapshots = worldSnapshotsSince(runStartedAt);
    if (snapshots.length > 0) {
      const paths = snapshots.map((path) => relative(repoRoot, path).split(sep).join("/"));
      process.stderr.write(`world receipt metadata from this run: ${paths.join(", ")}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    command: "evals:e2e",
    lane: "e2e",
    daytona: placement === "daytona",
    placement,
    engine: selection.engine ?? "legacy",
    surface: selection.surface ?? "legacy",
    contract: selection.plan,
    case: selection.caseId ?? null,
    vision: options.withLlmVision ? "inline" : "defer",
    files: options.testNames.length > 0 ? options.testNames : ["all"],
    ...summary,
    ...(selection.caseId ? { selectedCasePassed: verdict === "passed" } : {}),
    consented,
    verdict,
  })}\n`);
  return exitCodeFor(verdict, { named: options.testNames.length > 0 });
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage);
      return 0;
    }
    if (options.list) {
      const cases = registeredCases.map(value => `${value.id}  ${value.spec}\n  engines: ${value.engines.join(", ")}\n  ${caseCommand(value)}`);
      const files = options.testNames.length ? resolveTestNames(options.testNames) : journeyFiles();
      const entries = files.map(file => `${testName(file)}\n${discoverWorlds(file).map(world => `  ${worldContract(world)}`).join("\n")}\n  pnpm evals:e2e ${testName(file)}`);
      process.stdout.write(["Registered cases:", ...cases, "", "Discoverable tests:", ...entries].join("\n") + "\n");
      return 0;
    }
    return options.publish ? publish(options) : run(options);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
