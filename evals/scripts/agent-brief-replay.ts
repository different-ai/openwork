import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAY_SCENARIOS } from "./agent-replay/day-scenarios.ts";
import { chatCompletionsModel } from "./agent-replay/harness.ts";
import { agentSendCheckRequest, decideSendCheck } from "../../packages/automations/src/proactive-brief.ts";
import { runNewPipeline, runOldPipeline, type DayRun, type Pipeline, type ReplaySendCheck } from "./agent-replay/pipelines.ts";
import { judgeMessage, reportMarkdown, scoreDay, type DayScore } from "./agent-replay/score.ts";

/**
 * Replay evals for Your agent's brief (workbotAgentBrief): every recorded day (agent-replay/day-scenarios.ts) run
 * through today's prompts and the brief's two-step pipeline, N times each, with the same model and read-only tools;
 * scored deterministically and by an LLM judge (agent-replay/score.ts).
 *
 *   AI_GATEWAY_API_KEY=… pnpm --dir evals agent:brief-replay [--runs 3] [--only busy-morning] [--pipelines old,new]
 *     [--concurrency 6] [--model openai/gpt-6-luna] [--judge anthropic/claude-sonnet-4.5] [--send-check]
 *
 * --send-check runs the brief's pipeline with the send check (workbotAgentSendCheck): each message step 2 wrote is
 * read by typesafe-ai/jev before Den's limits. It needs its own JEV_AI_GATEWAY_API_KEY (a Vercel AI Gateway key); the
 * replay model's key is never used for it. Compare its report with a
 * run without the flag; runs.json lists what each check held and why. `--send-check shadow` holds nothing and writes
 * every answer with its probabilities to send-check.json, to see what a threshold would have held.
 *
 * Writes evals/results/agent-brief/<time>/{runs.json,report.md} and prints the report. Exits 2 without a model key.
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apiKey = process.env.OPENWORK_AGENT_REPLAY_API_KEY?.trim() || process.env.AI_GATEWAY_API_KEY?.trim();
const baseUrl = process.env.OPENWORK_AGENT_REPLAY_BASE_URL?.trim() || "https://ai-gateway.vercel.sh/v1";
const modelId = flag("--model") ?? process.env.OPENWORK_AGENT_REPLAY_MODEL?.trim() ?? "openai/gpt-6-luna";
const judgeId = flag("--judge") ?? "anthropic/claude-sonnet-4.5";
const runs = Math.max(1, Math.min(5, Number(flag("--runs") ?? 3) || 3));
const concurrency = Math.max(1, Math.min(16, Number(flag("--concurrency") ?? 6) || 6));
const only = flag("--only")?.split(",");
const pipelines = (flag("--pipelines") ?? "old,new").split(",").filter((entry): entry is Pipeline => entry === "old" || entry === "new");

type SendCheckEntry = { scenario: string; run: number; message: string; update: boolean; toldToday: number; skip: number | null; repeat: number | null; verdict: string };
const sendCheckLog: SendCheckEntry[] = [];

function probability(answers: unknown, id: "skip" | "repeat"): number | null {
  if (typeof answers !== "object" || answers === null || !(id in answers)) return null;
  const answer: unknown = Reflect.get(answers, id);
  const value: unknown = typeof answer === "object" && answer !== null ? Reflect.get(answer, "probability") : null;
  return typeof value === "number" ? value : null;
}

/**
 * The send check as Den asks it: one evaluation request per message; no usable answer sends the message. Every
 * answer is logged with its probabilities. `shadow` logs what would be held and holds nothing, so one run gives the
 * pipeline's own score and what any threshold would have held.
 */
function jevSendCheck(key: string, shadow: boolean, where: { scenario: string; run: number }): ReplaySendCheck {
  return async (input) => {
    const entry: SendCheckEntry = { ...where, message: input.message, update: input.update, toldToday: input.toldToday.length, skip: null, repeat: null, verdict: "unavailable" };
    sendCheckLog.push(entry);
    try {
      const response = await fetch("https://ai-gateway.vercel.sh/v4/ai/evaluation-model", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": "typesafe-ai/jev",
        },
        body: JSON.stringify({ ...agentSendCheckRequest(input), providerOptions: { gateway: { zeroDataRetention: true } } }),
      });
      if (!response.ok) {
        entry.verdict = `unavailable (HTTP ${response.status})`;
        return { kind: "send" };
      }
      const body: unknown = await response.json();
      const answers: unknown = typeof body === "object" && body !== null && "answers" in body ? body.answers : null;
      entry.skip = probability(answers, "skip");
      entry.repeat = probability(answers, "repeat");
      const verdict = decideSendCheck(answers, input);
      entry.verdict = verdict.kind === "hold" ? `hold:${verdict.reason}` : "send";
      return shadow ? { kind: "send" } : verdict;
    } catch {
      return { kind: "send" };
    }
  };
}
// Its own key, for Vercel's evaluation endpoint only. Never the replay model's key: that one may belong to a custom
// endpoint (OPENWORK_AGENT_REPLAY_BASE_URL) and must not be sent anywhere else.
const sendCheckKey = process.env.JEV_AI_GATEWAY_API_KEY?.trim();
const sendCheckMode = process.argv.includes("--send-check") ? (flag("--send-check") === "shadow" ? "shadow" : "hold") : null;

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task) results[index] = await task();
    }
  }));
  return results;
}

if (!apiKey) {
  console.log(JSON.stringify({ status: "configuration_error", reason: "set AI_GATEWAY_API_KEY or OPENWORK_AGENT_REPLAY_API_KEY" }));
  process.exitCode = 2;
} else if (sendCheckMode && !sendCheckKey) {
  console.log(JSON.stringify({ status: "configuration_error", reason: "--send-check needs JEV_AI_GATEWAY_API_KEY" }));
  process.exitCode = 2;
} else {
  const model = chatCompletionsModel({ baseUrl, apiKey, model: modelId });
  const judge = chatCompletionsModel({ baseUrl, apiKey, model: judgeId });
  const scenarios = DAY_SCENARIOS.filter((scenario) => !only || only.includes(scenario.id));
  const tasks = scenarios.flatMap((scenario) => pipelines.flatMap((pipeline) => Array.from({ length: runs }, (_, index) => async (): Promise<{ run: DayRun; score: DayScore }> => {
    const started = Date.now();
    const sendCheck = sendCheckMode && sendCheckKey ? jevSendCheck(sendCheckKey, sendCheckMode === "shadow", { scenario: scenario.id, run: index + 1 }) : undefined;
    const run = pipeline === "new" ? await runNewPipeline(scenario, model, { sendCheck }) : await runOldPipeline(scenario, model);
    const scored = scoreDay(scenario, run);
    const judged = await Promise.all(run.messages.map((message) => judgeMessage(judge, message.text).catch(() => null)));
    const score: DayScore = { ...scored, judged };
    console.log(`${run.error ? "ERROR" : "done "} ${pipeline} ${scenario.id} #${index + 1} ${Math.round((Date.now() - started) / 1000)}s: ${run.messages.length} messages, missed [${score.missed.join(", ")}], unwanted ${score.unwanted.length}${run.error ? ` (${run.error})` : ""}`);
    return { run, score };
  })));
  const results = await pool(tasks, concurrency);
  const usage = Object.fromEntries((["old", "new"] as const).map((pipeline) => {
    const checks = results.filter((result) => result.run.pipeline === pipeline).flatMap((result) => result.run.checks);
    const sum = (step: "check" | "message") => {
      const used = checks.filter((check) => check.usage[step].calls > 0);
      return used.reduce((total, check) => ({ calls: total.calls + check.usage[step].calls, input: total.input + check.usage[step].input, cached: total.cached + check.usage[step].cached, output: total.output + check.usage[step].output, checks: total.checks + 1 }), { calls: 0, input: 0, cached: 0, output: 0, checks: 0 });
    };
    return [pipeline, { check: sum("check"), message: sum("message") }];
  }));
  const report = reportMarkdown({
    scores: results.map((result) => result.score),
    scenarios,
    runs,
    model: modelId,
    judgeModel: judgeId,
    usage: { old: usage.old ?? { check: { calls: 0, input: 0, cached: 0, output: 0, checks: 0 }, message: { calls: 0, input: 0, cached: 0, output: 0, checks: 0 } }, new: usage.new ?? { check: { calls: 0, input: 0, cached: 0, output: 0, checks: 0 }, message: { calls: 0, input: 0, cached: 0, output: 0, checks: 0 } } },
  });
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "results", "agent-brief", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "runs.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "report.md"), `${report}\n`);
  if (sendCheckMode) writeFileSync(join(out, "send-check.json"), JSON.stringify(sendCheckLog, null, 2));
  console.log(`\n${report}\n\nWrote ${out}`);
}
