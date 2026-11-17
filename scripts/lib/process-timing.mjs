import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const git = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

/** @param {number} value */
function seconds(value) {
  return Math.round(Math.min(86400, Math.max(0, Number.isNaN(value) ? 0 : value)) * 1000) / 1000;
}

/** @param {string} value */
function stepName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._:-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
}

/** @param {AbortSignal} signal */
async function commit(signal) {
  for (const value of [process.env.OPENWORK_PROCESS_TIMING_HEAD_SHA, process.env.GITHUB_SHA]) {
    if (value && /^[0-9a-f]{40}$/.test(value)) return value;
  }
  try {
    const { stdout } = await git("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 200, maxBuffer: 1024, signal });
    const value = stdout.trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ step: string, seconds: number, outcome: "ok" | "fail" | "skipped" }} TimingStep
 * @typedef {{ process: "check" | "world" | "evals", startedAt: string, totalSeconds: number, outcome: "ok" | "fail", steps: TimingStep[] }} ProcessTiming
 */

/** @param {ProcessTiming} run */
export async function reportProcessTiming(run) {
  try {
    const url = process.env.OPENWORK_PROCESS_TIMING_URL;
    const key = process.env.OPENWORK_PROCESS_TIMING_KEY;
    if (!url || !key) return;
    const signal = AbortSignal.timeout(3000);
    const steps = run.steps.flatMap((entry) => {
      const step = stepName(entry.step);
      return step ? [{ step, seconds: seconds(entry.seconds), outcome: entry.outcome }] : [];
    });
    if (steps.length > 200) {
      steps.sort((left, right) => right.seconds - left.seconds);
      steps.length = 200;
    }
    if (!steps.length) return;
    const payload = {
      version: 1,
      runId: randomUUID(),
      process: run.process,
      environment: process.env.CI !== undefined ? "ci" : "local",
      commit: await commit(signal),
      startedAt: new Date(run.startedAt).toISOString(),
      totalSeconds: seconds(run.totalSeconds),
      outcome: run.outcome,
      steps,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("rejected");
  } catch {
    if (process.env.OPENWORK_PROCESS_TIMING_DEBUG === "1") {
      try { process.stderr.write("Process timing report failed.\n"); } catch {}
    }
  }
}
