import { chatCompletionsModel, runReplay, scoreReplay } from "./agent-replay/harness.ts";
import { REPLAY_TIMELINES } from "./agent-replay/timelines.ts";

/**
 * Live replay evals for Your agent: each recorded timeline, run N times against a real model with the agent's real
 * instructions and wake prompt, scored by agent-replay/harness.ts.
 *
 *   OPENAI_API_KEY=… pnpm --dir evals agent:replay [--runs 3] [--only slack-ask-before-call]
 *   AI_GATEWAY_API_KEY=… OPENWORK_AGENT_REPLAY_MODEL=openai/gpt-5.4 pnpm --dir evals agent:replay
 *
 * A timeline passes when every run passes. Prints one line per run and a JSON summary; exits 1 on any failure, 2 when
 * no model is configured.
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();
const apiKey = process.env.OPENWORK_AGENT_REPLAY_API_KEY?.trim() || openaiKey || gatewayKey;
const baseUrl = process.env.OPENWORK_AGENT_REPLAY_BASE_URL?.trim() || (openaiKey ? process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1" : "https://ai-gateway.vercel.sh/v1");
const model = process.env.OPENWORK_AGENT_REPLAY_MODEL?.trim() || (openaiKey ? "gpt-5.4" : "openai/gpt-5.4");
const runs = Math.max(1, Math.min(5, Number(flag("--runs") ?? 3) || 3));
const only = flag("--only");

if (!apiKey) {
  console.log(JSON.stringify({ status: "configuration_error", reason: "set OPENAI_API_KEY, AI_GATEWAY_API_KEY or OPENWORK_AGENT_REPLAY_API_KEY" }));
  process.exitCode = 2;
} else {
  const replayModel = chatCompletionsModel({ baseUrl, apiKey, model });
  const summary: { id: string; passed: number; runs: number; failures: string[] }[] = [];
  for (const timeline of REPLAY_TIMELINES.filter((entry) => !only || entry.id === only)) {
    const row = { id: timeline.id, passed: 0, runs, failures: [] as string[] };
    for (let run = 1; run <= runs; run += 1) {
      try {
        const result = await runReplay(timeline, replayModel);
        const verdict = scoreReplay(timeline, result);
        if (verdict.pass) row.passed += 1;
        else row.failures.push(...verdict.failures.map((failure) => `run ${run}: ${failure}`));
        const said = verdict.message ? ` — ${verdict.message.replaceAll("\n", " / ")}` : "";
        console.log(`${verdict.pass ? "PASS" : "FAIL"} ${timeline.id} #${run} ${verdict.reply} [${result.toolCalls.join(", ")}]${said}${verdict.pass ? "" : `\n     ${verdict.failures.join("\n     ")}`}`);
      } catch (error) {
        row.failures.push(`run ${run}: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`ERROR ${timeline.id} #${run} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    summary.push(row);
  }
  const passed = summary.every((row) => row.passed === row.runs);
  console.log(JSON.stringify({ status: passed ? "passed" : "failed", model, runs, timelines: summary }, null, 2));
  process.exitCode = passed ? 0 : 1;
}
