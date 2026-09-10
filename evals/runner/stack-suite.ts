import { planWorlds, worldContract } from "../scripts/world-plan.ts";

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const GLOB_MARKER = /[*?{}[\]]/;
const VITEST_VALUE_OPTIONS = new Set(["-t", "--testNamePattern", "--reporter", "--config", "--project"]);

function positionalArguments(argv: readonly string[]): string[] {
  const positional: string[] = [];
  let skipOptionValue = false;

  for (const argument of argv) {
    if (skipOptionValue) {
      skipOptionValue = false;
      continue;
    }
    if (VITEST_VALUE_OPTIONS.has(argument)) {
      skipOptionValue = true;
      continue;
    }
    if ([...VITEST_VALUE_OPTIONS].some((option) => option.startsWith("--") && argument.startsWith(`${option}=`))) continue;
    if (!argument.startsWith("-")) positional.push(argument);
  }

  return positional;
}

function explicitTestFiles(argv: readonly string[]): string[] {
  return positionalArguments(argv).filter((argument) => TEST_FILE.test(argument) && !GLOB_MARKER.test(argument));
}

export function parallelSuite(argv: readonly string[]): boolean {
  const testArguments = positionalArguments(argv).filter(
    (argument) => argument.includes(".test.") || GLOB_MARKER.test(argument),
  );
  return testArguments.length !== 1 || explicitTestFiles(testArguments).length !== 1;
}

function configuredWorkerCount(env: NodeJS.ProcessEnv): number {
  const configured = Number.parseInt(env.OPENWORK_EVAL_MAX_WORKERS?.trim() ?? "", 10);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return env.OPENWORK_EVAL_DAYTONA?.trim() === "1" ? 2 : 3;
}

export function suiteWorkerCount(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const fileCount = explicitTestFiles(argv).length;
  const workers = configuredWorkerCount(env);
  return fileCount > 0 ? Math.min(fileCount, workers) : workers;
}

export function planSuite(files: readonly string[], options: { pattern?: RegExp; surface?: string } = {}) {
  // The shared planner accepts a regex source, not flags. Refuse to silently
  // change configured regex semantics before provisioning anything.
  if (options.pattern?.flags) throw new Error("World planning requires a testNamePattern without regex flags.");
  const plan = planWorlds(files, { pattern: options.pattern?.source, surface: options.surface });
  return {
    ...plan,
    preparation: "none",
    diagnostic: [
      "[openwork/evals] world plan: lazy per-world allocation; suite preparation=none",
      ...plan.worlds.map(world => `[openwork/evals] ${world.file}:${world.line} ${worldContract(world)}`),
    ].join("\n"),
  };
}
