/**
 * Internal demo: demo-driven development demoing itself.
 *
 * Proves the voice-over-first DX end to end: the /voiceover entry point, the
 * "script before code" contract, the approved script as a checked-in artifact,
 * scaffolding + drift detection, the fraimz PR comment, and the merge-blocking
 * exit-code contract. Runs app-less (requiresApp: false): the protagonist is a
 * developer in a terminal, so evidence is claims + assertions + real command
 * output instead of screenshots.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs, voiceoverScriptPath } from "../runner/voiceover.mjs";
import { renderPrComment } from "../runner/pr.mjs";

const FLOW_ID = "voiceover-first-dx";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "evals", "runner", "run.mjs");

// Narration comes from the approved script; the runner's coverage step fails
// this flow if these lines ever drift from evals/voiceovers/voiceover-first-dx.md.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const exists = (path) => access(path).then(() => true, () => false);

/** Assert + record, so every check shows up as evidence in the frame. */
function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

export default {
  id: FLOW_ID,
  title: "Demo-driven development: voice-over instead of PRD, agents build until the demo holds",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "A feature starts with the /voiceover command, not a PRD",
      run: async (ctx) => {
        await ctx.prove("The /voiceover entry point exists and takes the feature as its argument", {
          voiceover: vo[0],
          assert: async () => {
            const commandPath = join(ROOT, ".opencode", "commands", "voiceover.md");
            witness(ctx, await exists(commandPath), ".opencode/commands/voiceover.md exists");
            const command = await readFile(commandPath, "utf8");
            witness(ctx, command.includes("$ARGUMENTS"), "The command takes the feature description as $ARGUMENTS");
            witness(ctx, command.toLowerCase().includes("instead of a prd"), "The command frames the voice-over as the PRD replacement");
            ctx.output(".opencode/commands/voiceover.md", command.split("\n").slice(0, 12).join("\n"));
          },
        });
      },
    },
    {
      name: "The voiceover skill drives alignment on words, not code",
      run: async (ctx) => {
        await ctx.prove("The skill's contract is explicit: no code until the script is approved", {
          voiceover: vo[1],
          assert: async () => {
            const skillPath = join(ROOT, ".opencode", "skills", "voiceover", "SKILL.md");
            witness(ctx, await exists(skillPath), ".opencode/skills/voiceover/SKILL.md exists");
            const skill = (await readFile(skillPath, "utf8")).replace(/\s+/g, " ");
            witness(ctx, skill.toLowerCase().includes("no code until the script is approved"), "Skill states the contract: no code until the script is approved");
            witness(ctx, skill.includes("one numbered paragraph per frame"), "Skill defines the script format (one numbered paragraph per frame)");
            ctx.output("The contract", skill.split("\n").filter((line) => line.includes("contract") || line.includes("Iterate on words")).join("\n"));
          },
        });
      },
    },
    {
      name: "The approved script is a checked-in artifact the code is held to",
      run: async (ctx) => {
        await ctx.prove("evals/voiceovers/<id>.md exists and parses into the demo's frames", {
          voiceover: vo[2],
          assert: async () => {
            const scriptPath = voiceoverScriptPath(FLOW_ID);
            witness(ctx, await exists(scriptPath), "The approved script exists at evals/voiceovers/voiceover-first-dx.md");
            witness(ctx, vo.length === 6, "The script parses into exactly 6 frame paragraphs", String(vo.length));
            witness(ctx, vo[0].includes("PRD"), "Frame 1 names the thing it replaces (the PRD)");
            ctx.output("evals/voiceovers/voiceover-first-dx.md", await readFile(scriptPath, "utf8"));
          },
        });
      },
    },
    {
      name: "Scaffold turns the script into proof steps; narration drift fails the run",
      run: async (ctx) => {
        const scaffoldId = "_scaffold-demo";
        const scaffoldScript = voiceoverScriptPath(scaffoldId);
        const flowsDir = await mkdtemp(join(tmpdir(), "fraimz-scaffold-"));
        try {
          await ctx.prove("One ctx.prove stub per paragraph, narration wired to the script file", {
            voiceover: vo[3],
            action: async () => {
              await writeFile(scaffoldScript, "# _scaffold-demo — fixture\n\n1. First fixture frame.\n\n2. Second fixture frame.\n");
            },
            assert: async () => {
              const scaffold = spawnSync(process.execPath, [RUNNER, "scaffold", scaffoldId], {
                encoding: "utf8",
                env: { ...process.env, OPENWORK_EVAL_FLOWS_DIR: flowsDir },
              });
              witness(ctx, scaffold.status === 0, "pnpm fraimz scaffold <id> exits 0", scaffold.stderr?.trim() || String(scaffold.status));
              ctx.output("$ pnpm fraimz scaffold _scaffold-demo", scaffold.stdout.trim());
              const stub = await readFile(join(flowsDir, `${scaffoldId}.flow.mjs`), "utf8");
              witness(ctx, (stub.match(/ctx\.prove\(/g) ?? []).length === 2, "The generated flow has one ctx.prove per script paragraph");
              witness(ctx, stub.includes("loadVoiceoverParagraphs"), "The generated flow loads its narration from the script file");
              // Drift, end to end: a flow that skips a scripted frame and
              // narrates an unapproved line must fail the real runner.
              await writeFile(join(flowsDir, `${scaffoldId}.flow.mjs`), `export default {
  id: ${JSON.stringify(scaffoldId)},
  title: "Drifted narration fixture",
  kind: "internal",
  requiresApp: false,
  steps: [{ name: "Narrates a drifted line", run: async (ctx) => {
    await ctx.prove("frame 1", { voiceover: "First fixture frame." });
    await ctx.prove("frame 2", { voiceover: "A line nobody approved." });
  } }],
};
`);
              const drifted = spawnSync(process.execPath, [RUNNER, "--flow", scaffoldId, "--out", flowsDir], {
                encoding: "utf8",
                env: { ...process.env, OPENWORK_EVAL_FLOWS_DIR: flowsDir },
                timeout: 60_000,
              });
              witness(ctx, drifted.status === 1, "A flow whose narration drifts from the approved script fails the run", String(drifted.status));
              witness(ctx, drifted.stdout.includes("Voice-over script coverage"), "The failure is attributed to the voice-over coverage step");
              ctx.output("$ pnpm fraimz --flow _scaffold-demo (drifted fixture)", drifted.stdout.trim().split("\n").slice(-7).join("\n"));
            },
          });
        } finally {
          await rm(scaffoldScript, { force: true });
          await rm(flowsDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "The fraimz lands on the PR as the reviewable demo",
      run: async (ctx) => {
        await ctx.prove("pnpm fraimz --flow <id> --pr renders the frame-by-frame proof as a PR comment", {
          voiceover: vo[4],
          assert: async () => {
            const body = renderPrComment({
              runId: "demo-run",
              summary: { passed: 1, failed: 0, skipped: 0 },
              flows: [{
                id: FLOW_ID,
                title: "Demo-driven development",
                kind: "internal",
                status: "passed",
                steps: [{
                  status: "passed",
                  evidence: [
                    { type: "claim", status: "passed", claim: "The demo holds", voiceover: vo[4] },
                    { type: "assertion", status: "passed", assertion: "Observable side effect witnessed" },
                  ],
                }],
              }],
            });
            witness(ctx, body.includes("## fraimz — ✅ PASSED"), "The comment leads with the verdict");
            witness(ctx, body.includes(`🎙 ${vo[4]}`), "Each frame carries its voice-over line");
            witness(ctx, body.includes("Observable side effect witnessed"), "Each frame lists its passing assertions");
            ctx.output("pr-comment.md (rendered)", body);
          },
        });
      },
    },
    {
      name: "A red demo is a failing run — and a failing run blocks the merge",
      run: async (ctx) => {
        const flowsDir = await mkdtemp(join(tmpdir(), "fraimz-red-"));
        const outDir = await mkdtemp(join(tmpdir(), "fraimz-red-out-"));
        try {
          await ctx.prove("The runner exits non-zero when any frame fails, while still writing the fraimz", {
            voiceover: vo[5],
            action: async () => {
              await writeFile(join(flowsDir, "_red-demo.flow.mjs"), `export default {
  id: "_red-demo",
  title: "Deliberately red demo (fixture)",
  kind: "internal",
  requiresApp: false,
  steps: [{ name: "This frame fails", run: async (ctx) => { ctx.assert(false, "red on purpose"); } }],
};
`);
            },
            assert: async () => {
              const run = spawnSync(process.execPath, [RUNNER, "--flow", "_red-demo", "--out", outDir], {
                encoding: "utf8",
                env: { ...process.env, OPENWORK_EVAL_FLOWS_DIR: flowsDir },
                timeout: 60_000,
              });
              witness(ctx, run.status === 1, "A failing frame makes the run exit 1 (the signal a required check consumes)", String(run.status));
              witness(ctx, run.stdout.includes("Result: FAILED"), "The verdict is stated honestly");
              const [redRunId] = run.stdout.match(/[\d-]+T[\dZ-]+/) ?? [];
              witness(ctx, Boolean(redRunId) && (await exists(join(outDir, redRunId, "fraimz.html"))), "The fraimz is still written for a red run, so the failure is reviewable");
              ctx.output("$ pnpm fraimz --flow _red-demo (fixture)", run.stdout.trim().split("\n").slice(-6).join("\n"));
            },
          });
        } finally {
          await rm(flowsDir, { recursive: true, force: true });
          await rm(outDir, { recursive: true, force: true });
        }
      },
    },
  ],
};
