import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the full ACME verification many times against one prepared snapshot, the
// way many reviewers launch it, and fails unless every run passes. Run only from
// the reviewed, pinned controller after prewarming. Each run launches and deletes
// its own clones; a killed run's clones still expire with their 10-minute TTL.
const [sha, runsArg = "10", concurrencyArg = "5"] = process.argv.slice(2);
if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Usage: node scripts/soak-freestyle-preview.ts <full-pushed-sha> [runs] [concurrency]");
const runs = Number(runsArg);
const concurrency = Number(concurrencyArg);
if (!Number.isInteger(runs) || runs < 1 || runs > 60) throw new Error("Soak runs must be 1–60.");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("Soak concurrency must be 1–10.");
const verify = fileURLToPath(new URL("./verify-freestyle-preview.ts", import.meta.url));
const RUN_TIMEOUT_MS = 12 * 60_000;

interface RunResult {
  index: number;
  passed: boolean;
  durationMs: number;
  reason: string;
  desktopChatStepMs?: Record<string, number>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Public log: the verifier's first error line, with anything token- or URL-shaped removed. */
function failureLine(stderr: string): string {
  const line = stderr.split("\n").map((entry) => entry.trim()).find((entry) => /^[A-Za-z]*Error(?: \[[A-Z_]+\])?:/.test(entry)) ?? "";
  return line.replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>").slice(0, 220);
}

async function chatSteps(dir: string): Promise<Record<string, number> | undefined> {
  try {
    const proof: unknown = JSON.parse(await readFile(join(dir, "freestyle-launch-proof.json"), "utf8"));
    if (!record(proof) || !record(proof.desktopChatStepMs)) return undefined;
    const steps: Record<string, number> = {};
    for (const [name, ms] of Object.entries(proof.desktopChatStepMs)) if (typeof ms === "number" && Number.isFinite(ms)) steps[name] = ms;
    return steps;
  } catch { return undefined; } // Failed runs write no proof.
}

async function run(index: number): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), `freestyle-soak-${index}-`));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY; // One summary for the soak, not one per run.
  const started = performance.now();
  const child = spawn(process.execPath, [verify, sha], { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-50_000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
  clearTimeout(timer);
  const durationMs = Math.round(performance.now() - started);
  const passed = code === 0;
  const steps = passed ? await chatSteps(dir) : undefined;
  return {
    index, passed, durationMs,
    reason: passed ? "" : code === null ? `killed after ${RUN_TIMEOUT_MS / 60_000} minutes` : failureLine(stderr) || `exit ${code}`,
    ...(steps ? { desktopChatStepMs: steps } : {}),
  };
}

const results: RunResult[] = [];
let next = 1;
await Promise.all(Array.from({ length: Math.min(concurrency, runs) }, async () => {
  while (next <= runs) {
    const index = next++;
    const result = await run(index);
    results.push(result);
    console.log(JSON.stringify(result));
  }
}));
results.sort((a, b) => a.index - b.index);
const passed = results.filter((result) => result.passed).length;
const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
const percentile = (p: number) => durations[Math.min(durations.length - 1, Math.floor(p * durations.length))];
const failures = new Map<string, number>();
for (const result of results) if (!result.passed) failures.set(result.reason, (failures.get(result.reason) ?? 0) + 1);
// Rule of three: zero failures in n runs bounds the true failure rate below 3/n at 95% confidence.
const bound = passed === runs ? `0 failures in ${runs} runs bounds the failure rate below ${(300 / runs).toFixed(1)}% at 95% confidence.` : "";
const proof = {
  gitSha: sha, world: "acme-web", runs, concurrency, passed, failed: runs - passed,
  p50Ms: percentile(0.5), p95Ms: percentile(0.95), bound,
  failures: [...failures].map(([reason, count]) => ({ reason, count })), results,
  scope: "Each run is the complete CI verification: two fresh clones of one prepared snapshot, isolation, demo sign-in, a fresh gateway reply, the desktop viewer and a desktop chat, then deletion.",
};
await writeFile("freestyle-soak-proof.json", JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ passed, runs, p50Ms: proof.p50Ms, p95Ms: proof.p95Ms, failures: proof.failures }));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `\n## ACME soak: ${passed}/${runs} passed\n\nCommit: \`${sha}\` · ${concurrency} at a time · p50 ${(proof.p50Ms / 1000).toFixed(1)} s · p95 ${(proof.p95Ms / 1000).toFixed(1)} s per run\n\n${bound || "| Failure | Runs |\n| --- | --- |\n" + proof.failures.map((item) => `| ${item.reason.replaceAll("|", "\\|")} | ${item.count} |`).join("\n")}\n\n${proof.scope}\n`);
if (passed !== runs) process.exitCode = 1;
