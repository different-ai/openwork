import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "typed-automation-dx";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "evals", "runner", "run.mjs");
const RUN_TIMEOUT_MS = 120_000;
const LONG_RUN_TIMEOUT_MS = 240_000;

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: string): void {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

function envWith(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

function envWithoutEvalOverrides(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = envWith(overrides);
  delete env.OPENWORK_EVAL_FLOWS_DIR;
  delete env.OPENWORK_EVAL_VOICEOVERS_DIR;
  return env;
}

function spawnNode(args: string[], env: NodeJS.ProcessEnv, timeout: number): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout,
  });
}

function spawnPnpm(args: string[], env: NodeJS.ProcessEnv, timeout: number): SpawnSyncReturns<string> {
  return spawnSync("pnpm", args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout,
  });
}

function commandOutput(run: SpawnSyncReturns<string>): string {
  const parts: string[] = [];
  if (run.stdout.trim()) parts.push(run.stdout.trim());
  if (run.stderr.trim()) parts.push(run.stderr.trim());
  if (run.error) parts.push(run.error.message);
  return parts.join("\n");
}

function tail(text: string, lineCount: number): string {
  return text.trim().split("\n").slice(-lineCount).join("\n");
}

function firstLines(text: string, lineCount: number): string {
  return text.trim().split("\n").slice(0, lineCount).join("\n");
}

function lineStartingWith(text: string, prefix: string): string | null {
  return text.split("\n").find((line) => line.startsWith(prefix)) ?? null;
}

function lineForScript(packageJson: string, scriptName: string): string | null {
  return packageJson.split("\n").find((line) => line.trim().startsWith(`"${scriptName}":`)) ?? null;
}

function outputLines(text: string, limit: number): string {
  return text.trim().split("\n").filter(Boolean).slice(0, limit).join("\n");
}

export default defineFlow({
  id: FLOW_ID,
  title: "Typed automation DX: automation mode, demo mode, scaffold, and typecheck stay distinct",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Two front doors keep evals and fraimz distinct",
      run: async (ctx) => {
        const flowsDir = await mkdtemp(join(tmpdir(), "typed-automation-plain-flows-"));
        const voiceoversDir = await mkdtemp(join(tmpdir(), "typed-automation-plain-voiceovers-"));
        const outDir = await mkdtemp(join(tmpdir(), "typed-automation-plain-out-"));
        try {
          await ctx.prove("pnpm evals runs automation mode while pnpm fraimz runs demo mode", {
            voiceover: vo[0],
            action: async () => {
              await writeFile(join(flowsDir, "_plain-automation.flow.mjs"), `export default {
  id: "_plain-automation",
  title: "Plain automation fixture",
  kind: "internal",
  requiresApp: false,
  steps: [{ name: "Plain passing proof", run: async (ctx) => {
    await ctx.prove("Plain automation proves without narration", {
      assert: async () => { ctx.assert(true, "plain automation passed"); },
    });
  } }],
};
`);
            },
            assert: async () => {
              const packageJson = await readFile(join(ROOT, "package.json"), "utf8");
              const evalsLine = lineForScript(packageJson, "evals");
              const fraimzLine = lineForScript(packageJson, "fraimz");
              witness(ctx, evalsLine?.includes("--mode automation"), "package.json evals script uses --mode automation", evalsLine ?? "missing evals script");
              witness(ctx, fraimzLine?.includes("--mode demo"), "package.json fraimz script uses --mode demo", fraimzLine ?? "missing fraimz script");
              ctx.output("package.json scripts", [evalsLine, fraimzLine].filter((line) => line !== null).join("\n"));

              const run = spawnNode(
                [RUNNER, "--mode", "automation", "--flow", "_plain-automation", "--out", outDir],
                envWith({ OPENWORK_EVAL_FLOWS_DIR: flowsDir, OPENWORK_EVAL_VOICEOVERS_DIR: voiceoversDir }),
                RUN_TIMEOUT_MS,
              );
              const fraimzOutputLine = lineStartingWith(run.stdout, "fraimz: ");
              const fraimzPath = fraimzOutputLine ? fraimzOutputLine.slice("fraimz: ".length).trim() : null;
              let fraimzExists = false;
              if (fraimzPath) fraimzExists = await exists(fraimzPath);
              witness(ctx, run.status === 0, "Plain fixture passes in automation mode", commandOutput(run));
              witness(ctx, fraimzExists, "Plain fixture writes fraimz.html in its run dir", fraimzPath ?? "missing fraimz line");
              ctx.output("$ pnpm evals --flow _plain-automation (fixture tail)", tail(commandOutput(run), 8));
            },
          });
        } finally {
          await rm(flowsDir, { recursive: true, force: true });
          await rm(voiceoversDir, { recursive: true, force: true });
          await rm(outDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "Demo narration drift is decoupled from automation runs",
      run: async (ctx) => {
        const flowsDir = await mkdtemp(join(tmpdir(), "typed-automation-drift-flows-"));
        const voiceoversDir = await mkdtemp(join(tmpdir(), "typed-automation-drift-voiceovers-"));
        const demoOutDir = await mkdtemp(join(tmpdir(), "typed-automation-drift-demo-out-"));
        const automationOutDir = await mkdtemp(join(tmpdir(), "typed-automation-drift-auto-out-"));
        try {
          await ctx.prove("Narration drift fails demo mode and passes automation mode for the same fixture", {
            voiceover: vo[1],
            action: async () => {
              await writeFile(join(voiceoversDir, "_drift-fixture.md"), `# _drift-fixture — fixture

1. First approved frame.

2. Second approved frame.
`);
              await writeFile(join(flowsDir, "_drift-fixture.flow.mjs"), `export default {
  id: "_drift-fixture",
  title: "Drifted narration fixture",
  kind: "internal",
  requiresApp: false,
  steps: [{ name: "Narrates approved and unapproved lines", run: async (ctx) => {
    await ctx.prove("frame 1", { voiceover: "First approved frame." });
    await ctx.prove("frame 2", { voiceover: "A line nobody approved." });
  } }],
};
`);
            },
            assert: async () => {
              const fixtureEnv = envWith({ OPENWORK_EVAL_FLOWS_DIR: flowsDir, OPENWORK_EVAL_VOICEOVERS_DIR: voiceoversDir });
              const demoRun = spawnNode([RUNNER, "--mode", "demo", "--flow", "_drift-fixture", "--out", demoOutDir], fixtureEnv, RUN_TIMEOUT_MS);
              witness(ctx, demoRun.status === 1, "Drifted fixture exits 1 in demo mode", commandOutput(demoRun));
              witness(ctx, demoRun.stdout.includes("Voice-over script coverage"), "Demo output includes the voice-over coverage step", tail(demoRun.stdout, 10));

              const automationRun = spawnNode([RUNNER, "--mode", "automation", "--flow", "_drift-fixture", "--out", automationOutDir], fixtureEnv, RUN_TIMEOUT_MS);
              witness(ctx, automationRun.status === 0, "The same drifted fixture exits 0 in automation mode", commandOutput(automationRun));
              witness(ctx, automationRun.stdout.includes("Result: PASSED"), "Automation output reports Result: PASSED", tail(automationRun.stdout, 10));
              ctx.output("$ pnpm fraimz --flow _drift-fixture (fixture tail)", tail(commandOutput(demoRun), 10));
              ctx.output("$ pnpm evals --flow _drift-fixture (fixture tail)", tail(commandOutput(automationRun), 8));
            },
          });
        } finally {
          await rm(flowsDir, { recursive: true, force: true });
          await rm(voiceoversDir, { recursive: true, force: true });
          await rm(demoOutDir, { recursive: true, force: true });
          await rm(automationOutDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "Automation scaffolding creates a plain typed stub without a script",
      run: async (ctx) => {
        const flowsDir = await mkdtemp(join(tmpdir(), "typed-automation-scaffold-flows-"));
        const voiceoversDir = await mkdtemp(join(tmpdir(), "typed-automation-scaffold-voiceovers-"));
        try {
          await ctx.prove("Automation scaffold writes a typed stub, while demo scaffold requires an approved script", {
            voiceover: vo[2],
            assert: async () => {
              const fixtureEnv = envWith({ OPENWORK_EVAL_FLOWS_DIR: flowsDir, OPENWORK_EVAL_VOICEOVERS_DIR: voiceoversDir });
              const automationScaffold = spawnNode([RUNNER, "--mode", "automation", "scaffold", "_plain-demo"], fixtureEnv, RUN_TIMEOUT_MS);
              const stubPath = join(flowsDir, "_plain-demo.flow.ts");
              const stubExists = await exists(stubPath);
              const stub = stubExists ? await readFile(stubPath, "utf8") : "";
              witness(ctx, automationScaffold.status === 0, "Automation scaffold without a script exits 0", commandOutput(automationScaffold));
              witness(ctx, stubExists, "Automation scaffold generated _plain-demo.flow.ts", stubPath);
              witness(ctx, stub.includes("defineFlow"), "Generated stub uses defineFlow", firstLines(stub, 20));
              witness(ctx, !stub.includes("voiceover"), "Generated plain stub does not contain voiceover", firstLines(stub, 20));
              witness(ctx, !stub.includes("loadVoiceoverParagraphs"), "Generated plain stub does not load voice-over paragraphs", firstLines(stub, 20));

              const demoScaffold = spawnNode([RUNNER, "--mode", "demo", "scaffold", "_needs-script"], fixtureEnv, RUN_TIMEOUT_MS);
              const demoScaffoldOutput = commandOutput(demoScaffold);
              witness(ctx, demoScaffold.status !== 0, "Demo scaffold without a script exits non-zero", demoScaffoldOutput);
              witness(ctx, demoScaffoldOutput.includes("Write and approve the script first"), "Demo scaffold explains the approved-script requirement", demoScaffoldOutput);
              ctx.output("$ pnpm evals scaffold _plain-demo (fixture)", commandOutput(automationScaffold));
              ctx.output("generated _plain-demo.flow.ts (first 20 lines)", firstLines(stub, 20));
              ctx.output("$ pnpm fraimz scaffold _needs-script (fixture)", demoScaffoldOutput);
            },
          });
        } finally {
          await rm(flowsDir, { recursive: true, force: true });
          await rm(voiceoversDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "TypeScript catches flow contract misuse before runtime",
      run: async (ctx) => {
        const fixtureDir = join(ROOT, "evals", ".tmp-typecheck-fixture");
        try {
          await ctx.prove("The eval runner typechecks, and a context API misuse fails tsc", {
            voiceover: vo[3],
            assert: async () => {
              const typecheck = spawnPnpm(["exec", "tsc", "-p", "evals"], envWithoutEvalOverrides(), RUN_TIMEOUT_MS);
              witness(ctx, typecheck.status === 0, "pnpm exec tsc -p evals exits 0", commandOutput(typecheck));
              ctx.output("$ pnpm exec tsc -p evals", `exit ${String(typecheck.status)}`);

              await rm(fixtureDir, { recursive: true, force: true });
              await mkdir(fixtureDir, { recursive: true });
              await writeFile(join(fixtureDir, "tsconfig.json"), `{
  "extends": "../tsconfig.json",
  "include": ["./broken.flow.ts"]
}
`);
              // The fixture lives under evals/ so it can import the real typed
              // runner contract with a normal relative NodeNext .ts specifier.
              await writeFile(join(fixtureDir, "broken.flow.ts"), `import { defineFlow } from "../runner/flow.ts";

export default defineFlow({
  id: "_broken-fixture",
  title: "Broken typed flow fixture",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Misuses the typed context",
      run: async (ctx) => {
        await ctx.clickText(42);
      },
    },
  ],
});
`);
              const brokenTypecheck = spawnPnpm(["exec", "tsc", "-p", "evals/.tmp-typecheck-fixture/tsconfig.json"], envWithoutEvalOverrides(), RUN_TIMEOUT_MS);
              const brokenOutput = commandOutput(brokenTypecheck);
              witness(ctx, brokenTypecheck.status !== 0, "A flow that misuses ctx.clickText fails typecheck", brokenOutput);
              witness(ctx, brokenTypecheck.stdout.includes("not assignable"), "The compiler reports the wrong argument is not assignable", brokenOutput);
              ctx.output("$ pnpm exec tsc -p evals/.tmp-typecheck-fixture/tsconfig.json", outputLines(brokenOutput, 12));
            },
          });
        } finally {
          await rm(fixtureDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "Legacy flows and runner unit tests still pass",
      run: async (ctx) => {
        await ctx.prove("The real flow list still includes legacy flows, and runner tests stay green", {
          voiceover: vo[4],
          assert: async () => {
            const listRun = spawnNode([RUNNER, "--mode", "automation", "--list"], envWithoutEvalOverrides(), RUN_TIMEOUT_MS);
            const flowLines = listRun.stdout.split("\n").filter((line) => line.trim().length > 0);
            witness(ctx, listRun.status === 0, "Automation list exits 0", commandOutput(listRun));
            witness(ctx, listRun.stdout.includes("app-smoke"), "Flow list includes the typed app-smoke flow", outputLines(listRun.stdout, 20));
            witness(ctx, flowLines.length >= 200, "Flow list contains at least 200 flows", String(flowLines.length));
            witness(ctx, listRun.stdout.includes("core-flow"), "Flow list includes legacy .mjs flow core-flow", outputLines(listRun.stdout, 20));

            const tests = spawnPnpm(["evals:test"], envWithoutEvalOverrides(), RUN_TIMEOUT_MS);
            const testOutput = commandOutput(tests);
            witness(ctx, tests.status === 0, "pnpm evals:test exits 0", testOutput);
            witness(ctx, testOutput.includes("pass 4"), "Runner unit tests report pass 4", tail(testOutput, 12));
            ctx.output("$ pnpm evals --list (first 20 lines)", outputLines(listRun.stdout, 20));
            ctx.output("$ pnpm evals:test", tail(testOutput, 12));
          },
        });
      },
    },
    {
      name: "Default runner mode remains the demo path",
      run: async (ctx) => {
        const outDir = await mkdtemp(join(tmpdir(), "typed-automation-default-demo-out-"));
        try {
          await ctx.prove("Running without --mode still executes the voiceover-first demo with coverage", {
            voiceover: vo[5],
            assert: async () => {
              const run = spawnNode([RUNNER, "--flow", "voiceover-first-dx", "--out", outDir], envWithoutEvalOverrides(), LONG_RUN_TIMEOUT_MS);
              witness(ctx, run.status === 0, "Default-mode voiceover-first-dx exits 0", commandOutput(run));
              witness(ctx, run.stdout.includes("Voice-over script coverage"), "Default-mode output includes the voice-over coverage step", tail(run.stdout, 12));
              witness(ctx, run.stdout.includes("Result: PASSED"), "Default-mode output reports Result: PASSED", tail(run.stdout, 12));
              ctx.output("$ pnpm fraimz --flow voiceover-first-dx (no --mode flag tail)", tail(commandOutput(run), 12));
            },
          });
        } finally {
          await rm(outDir, { recursive: true, force: true });
        }
      },
    },
  ],
});
