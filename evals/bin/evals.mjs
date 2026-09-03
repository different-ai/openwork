#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evalsDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const testsDir = join(evalsDir, "specs");
const worldsDir = join(evalsDir, "results/.worlds");

const usage = `Usage: node evals/bin/evals.mjs [test-names...] [flags]

Run E2E tests:
  --with-llm-vision  Judge vision claims inline (default: defer judging)
  --local            Force isolated local resources and clear inherited remote placement
  --daytona          Set OPENWORK_EVAL_DAYTONA=1
  --den <url>        Set OPENWORK_EVAL_DEN_API_URL=<url>

Judge then publish evidence:
  --publish         Enter judge-then-publish mode
  --pr <n>          Publish to pull request n
  --test-run <value> Select a test run path, directory ID, name, or latest (default: latest)
  --dry-run         Render publication output without posting
  --force           Forward force to the publisher

Other:
  --help, -h        Show this help

Publish mode cannot be combined with test names, --with-llm-vision, --daytona,
--local, or --den. Named tests auto-consent to opt-in flags declared in their source;
value-bearing environment variables are never auto-set.

Run exit codes:
  0  Passed, or an unfiltered E2E suite completed with expected skips
  1  One or more tests failed
  2  A named test skipped and its result is incomplete

Publish exit codes:
  0  Judge and publisher succeeded
  1  Failed claims were published, or publishing failed
  2  Pending claims require judging before publication
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

  return [...variables].sort();
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
    else if (arg === "--local") options.local = true;
    else if (arg === "--daytona") options.daytona = true;
    else if (arg === "--publish") options.publish = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--den" || arg === "--pr" || arg === "--test-run") {
      const value = valueAfter(args, index, arg);
      if (arg === "--den") options.den = value;
      else if (arg === "--pr") options.pr = value;
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

  if (options.publish) {
    const conflicts = [];
    if (options.testNames.length > 0) conflicts.push("test names");
    if (options.withLlmVision) conflicts.push("--with-llm-vision");
    if (options.local) conflicts.push("--local");
    if (options.daytona) conflicts.push("--daytona");
    if (options.den !== undefined) conflicts.push("--den");
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
    if (publishFlags.length > 0) {
      throw new Error(`${publishFlags.join(", ")} require --publish.`);
    }
  }

  return options;
}

const REMOTE_PLACEMENT_ENV = [
  "OPENWORK_EVAL_DAYTONA",
  "OPENWORK_EVAL_DAYTONA_SANDBOX",
  "OPENWORK_EVAL_DAYTONA_SANDBOX_ID",
  "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX",
  "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX",
  "OPENWORK_EVAL_DEN_API_URL",
  "OPENWORK_EVAL_DEN_WEB_URL",
];

/** Resolve the child environment before any test process can provision resources. */
export function resolveRunEnvironment(options, env = process.env) {
  const childEnv = { ...env };
  if (options.local) {
    for (const name of REMOTE_PLACEMENT_ENV) delete childEnv[name];
    return childEnv;
  }
  if (options.daytona) childEnv.OPENWORK_EVAL_DAYTONA = "1";
  if (options.den !== undefined) childEnv.OPENWORK_EVAL_DEN_API_URL = options.den;
  return childEnv;
}

function testFiles(directory = testsDir) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.e2e\.test\.ts$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

export function resolveTestNames(names, files = testFiles()) {
  const entries = files.map((file) => ({
    file,
    base: basename(file),
    relative: relative(testsDir, file).split(sep).join("/"),
  }));
  const resolved = [];

  for (const name of names) {
    const normalized = name.replace(/^\.\//, "").replace(/^specs\//, "");
    let matches = entries.filter((entry) => entry.relative === normalized);
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

export function verdictFor(summary, { childExit = 0 } = {}) {
  if ((summary.failed ?? 0) > 0 || childExit !== 0) return "failed";
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
  const testRun = options.testRun ?? "latest";
  const judge = spawnSync(process.execPath, [
    join(evalsDir, "packages/test-evidence/bin/test-evidence-judge.mjs"),
    "--test-run",
    testRun,
  ], { cwd: repoRoot, env: process.env, stdio: "inherit" });
  const judgeStatus = childStatus(judge);

  if (judgeStatus === 2 && !options.dryRun) {
    process.stderr.write("Pending claims need OPENAI_API_KEY or ANTHROPIC_API_KEY for judging; rerun after providing one, or use --dry-run.\n");
    return 2;
  }
  if (![0, 1, 2].includes(judgeStatus)) return judgeStatus;

  const publishArgs = [join(evalsDir, "packages/test-artifacts/bin/publish-pr.mjs")];
  if (options.pr) publishArgs.push("--pr", options.pr);
  if (options.testRun) publishArgs.push("--test-run", options.testRun);
  if (options.dryRun) publishArgs.push("--dry-run");
  if (options.force) publishArgs.push("--force");
  const published = spawnSync(process.execPath, publishArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  const publishStatus = childStatus(published);
  return judgeStatus === 1 && publishStatus === 0 ? 1 : publishStatus;
}

function run(options) {
  const runStartedAt = Date.now();
  const resolved = resolveTestNames(options.testNames);
  const childEnv = resolveRunEnvironment(options);
  childEnv.OPENWORK_EVAL_E2E_TESTS = "1";
  const consented = new Set(["OPENWORK_EVAL_E2E_TESTS"]);

  for (const file of resolved) {
    for (const variable of consentVarsFromSource(readFileSync(file, "utf8"))) {
      if (Object.hasOwn(process.env, variable)) continue;
      childEnv[variable] = "1";
      consented.add(variable);
    }
  }
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
    ...resolved.map((file) => relative(evalsDir, file).split(sep).join("/")),
  ];
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
  const summary = summarize(report);
  const verdict = verdictFor(summary, { childExit: status });
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
    daytona: childEnv.OPENWORK_EVAL_DAYTONA?.trim() === "1",
    placement: options.local
      ? "local"
      : options.daytona
        ? "daytona"
        : options.den !== undefined
          ? "attached"
          : "automatic",
    vision: options.withLlmVision ? "inline" : "defer",
    files: options.testNames.length > 0 ? options.testNames : ["all"],
    ...summary,
    consented: [...consented].sort(),
    verdict,
  })}\n`);
  return exitCodeFor(verdict, { named: resolved.length > 0 });
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage);
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
