#!/usr/bin/env node
// Explicit opt-in, local-only paid comparison. This launches the native proof, never performs the workplace tasks.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSHOP_MODEL_ORDER, WORKSHOP_SCENES, WORKSHOP_LIMITS, verifyWorkshopMatrix } from "../worlds/workshop-narrative-contract.ts";
import { workshopRunIdentity } from "../worlds/workshop-run-identity.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const directory = join(root, "evals/results/workshop-narrative", stamp);
await mkdir(directory, { recursive: true });
async function sourceDigest() { return (await workshopRunIdentity()).sourceDigest; }
const { sourceDigest: hash, promptDigest } = await workshopRunIdentity();
const phases: Record<string, unknown>[] = [];
let cleanupRequested = false;
let active: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanupRequested = true; active?.kill("SIGINT"); });
for (const [index, profile] of WORKSHOP_MODEL_ORDER.entries()) {
  if (cleanupRequested) break;
  if (await sourceDigest() !== hash) throw new Error("Proof/fixture source changed between subjects; comparison refused.");
  const reportDir = join(directory, profile);
  await mkdir(reportDir, { recursive: true });
  console.log(`\n[workshop] phase ${index + 1}/2: ${profile}; placement local; fresh owned world; identical prompts ${promptDigest}`);
  const started = Date.now();
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn("pnpm", ["evals:e2e", "workshop-narrative", "--local", "--surface", "web", "--engine", "v1"], {
      cwd: root, stdio: "inherit", env: { ...process.env, OPENWORK_WORKSHOP_NARRATIVE: "1", OPENWORK_WORKSHOP_PROFILE: profile, OPENWORK_WORKSHOP_REPORT_DIR: reportDir, OPENWORK_WORKSHOP_GPT_PHASE_DONE: index === 1 ? "1" : "0" },
    });
    active = child;
    child.once("error", () => resolve(1));
    child.once("exit", (code) => { active = undefined; resolve(code ?? 1); });
  });
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(await readFile(join(reportDir, "matrix.json"), "utf8")); }
  catch { raw = { verdict: "INCOMPLETE", profile, rows: WORKSHOP_SCENES.map((scene) => ({ id: scene.id, title: scene.title, status: "BLOCKED", reason: "Native proof did not produce its observer matrix; inspect its private test-run record", latencyMs: 0 })) }; }
  phases.push({ ...raw, nativeExitCode: exitCode, wallMs: Date.now() - started, promptDigest, sourceDigest: hash });
}
const rowArray = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
const seedDigests = phases.map((phase) => phase.seedDigest).filter((value): value is string => typeof value === "string");
const sameSeed = seedDigests.length === 2 && seedDigests[0] === seedDigests[1];
const aggregate = verifyWorkshopMatrix(phases.map((phase) => ({ model: String(phase.profile), elapsedMs: Number(phase.wallMs), scenes: rowArray(phase.rows).map((row) => {
  const scene = WORKSHOP_SCENES.find((scene) => scene.id === row.id);
  if (!scene) throw new Error("Native matrix returned an unknown scene");
  const facts = row.evidence !== null && typeof row.evidence === "object" ? Object.fromEntries(Object.entries(row.evidence)) : {};
  return { id: scene.id, status: row.status === "PASS" ? "PASS" : row.status === "FAIL" ? "FAIL" : "BLOCKED", reasons: [String(row.reason)], usage: { costUsd: typeof facts.estimatedUsd === "number" ? facts.estimatedUsd : null, costKind: "estimate", tokens: typeof facts.inputTokens === "number" && typeof facts.outputTokens === "number" ? facts.inputTokens + facts.outputTokens : null } };
}) })));
const complete = sameSeed && aggregate.status === "PASS" && phases.every((phase) => phase.nativeExitCode === 0);
const comparison = { verdict: complete ? "PASS" : "INCOMPLETE", aggregate, modelOrder: WORKSHOP_MODEL_ORDER, promptDigest, sourceDigest: hash, identicalInitialBusinessState: sameSeed, limits: WORKSHOP_LIMITS, phases };
await writeFile(join(directory, "comparison.json"), JSON.stringify(comparison, null, 2) + "\n");
const clean = (value: unknown) => String(value ?? "unavailable").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[credential-redacted]").replace(/\/(?:Users|private\/var|var\/folders)\/[^\s;,)]+/g, "[local-path]").replace(/\|/g, "\\|").replace(/\s+/g, " ");
const table = WORKSHOP_SCENES.map((scene) => {
  const cells = phases.map((phase) => { const row = rowArray(phase.rows).find((item) => item.id === scene.id); return row ? `${clean(row.status)} — ${clean(row.reason)}` : "BLOCKED — phase not reached"; });
  return `| ${scene.id} ${scene.title} | ${cells[0] ?? "BLOCKED"} | ${cells[1] ?? "BLOCKED"} |`;
}).join("\n");
const markdown = `# Full workshop model comparison\n\n**${comparison.verdict}**. This report does not drop failed or unsupported scenes. Native checks deliberately fail when the full narrative is incomplete.\n\nOrder: GPT-6.1 Sol FAST, then Qwen3.8 27B. Each phase owns a fresh local Den, app-web runtime, credentials and synthetic service state. Initial service-state hashes match: **${sameSeed}**. Same prompt/assertion/limit digest: \`${promptDigest}\`. Tested source digest: \`${hash}\`.\n\n| Scene | GPT-6.1 Sol FAST | Qwen3.8 27B |\n|---|---|---|\n${table}\n\n## Timing, usage and evidence\n\n${phases.map((phase) => `- ${phase.profile}: native exit ${phase.nativeExitCode}; wall time ${Math.round(Number(phase.wallMs) / 1000)} s. Exact model/protocol/tier, per-scene latency, request token totals, reported/estimated cost and blockers are in the sanitized comparison JSON. Missing costs remain unavailable, never zero-dollar claims.`).join("\n")}\n\nScreenshots and native captions are in the local native test-run galleries under \`evals/results/test-runs/\`; raw receipts, credentials and transcripts are private and must not be committed. PPTX validation opens actual downloaded OOXML with python-pptx; it does not claim Office UI rendering. Calendar evidence shows the bounded event fixture, not full Outlook parity. Simulated due events without dispatched inference/delivery do not pass T10. Model claims do not satisfy UI feedback T08.\n\nCommand: \`OPENWORK_EVAL_MYSQL_URL=<owned-local-MySQL-base> node evals/scripts/run-workshop-narrative.ts\`. Keys are retrieved only by the scoped world consumer from Infisical dev (OpenAI root; OpenRouter /openwork-ops), never supplied on the command line or stored in the report.\n`;
await writeFile(join(directory, "comparison.md"), markdown);
console.log(`[workshop] ${comparison.verdict}; local comparison: ${join(directory, "comparison.md")}`);
process.exitCode = complete ? 0 : 1;
