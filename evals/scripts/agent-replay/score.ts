import { z } from "zod";
import type { DayScenario } from "./day.ts";
import type { ReplayModel } from "./harness.ts";
import type { DayRun, DeliveredMessage, Pipeline } from "./pipelines.ts";

/**
 * Scoring a replayed day. Deterministic first: which messages tell what the scenario says must be told and by when,
 * which interrupt (a message about nothing required, about something never worth it, or a repeat), whether a quiet
 * day stayed quiet, and the writing rules that can be measured (the lead's length, the whole length, a link, no
 * headings, bullets, bold or emoji). Then an LLM judge for what can't be measured (one finding, a concrete fact, says
 * what was checked, one next step, the lead stands alone).
 */

/** A link as Slack renders it, `<url|label>`, read as its label; a bare URL counts as a link too. */
const SLACK_LINK = /<(https?:\/\/[^|>\s]+)\|([^>]+)>/g;
export function visibleText(text: string): string {
  return text.replace(SLACK_LINK, "$2").replace(/\s+/g, " ").trim();
}

/** The lead: the visible text up to the first sentence end. */
export function firstSentence(text: string): string {
  const visible = visibleText(text);
  const end = visible.search(/[.!?](\s|$)/);
  return end >= 0 ? visible.slice(0, end + 1) : visible;
}

const EMOJI = /\p{Extended_Pictographic}/u;
export type MessageChecks = { leadChars: number; chars: number; leadOk: boolean; lengthOk: boolean; hasLink: boolean; plain: boolean };

export function measureMessage(text: string): MessageChecks {
  const lead = firstSentence(text);
  const chars = visibleText(text).length;
  const plain = !/^\s*#{1,6}\s|^\s*[-*•]\s|\*\*|__/m.test(text) && !EMOJI.test(text);
  return { leadChars: lead.length, chars, leadOk: lead.length <= 120, lengthOk: chars <= 350, hasLink: /<https?:\/\/[^|>\s]+\|[^>]+>/.test(text) || /https?:\/\//.test(text), plain };
}

export type JudgeVerdict = { standsAlone: boolean; oneFinding: boolean; concreteFact: boolean; saysChecked: boolean; oneNextStep: boolean };
const verdictSchema = z.object({ stands_alone: z.boolean(), one_finding: z.boolean(), concrete_fact: z.boolean(), says_checked: z.boolean(), one_next_step: z.boolean() });

const JUDGE_PROMPT = [
  "You grade one Slack message an assistant sent to a busy person about their work. Judge only the message, strictly:",
  "- stands_alone: the first sentence alone (as a phone lock screen shows it) says what is happening and why it matters now, in about 100 characters or fewer.",
  "- one_finding: the message is about one thing (one finding), not a list or two unrelated topics.",
  "- concrete_fact: it gives a concrete fact: a name, number, date or time.",
  "- says_checked: it says what the assistant checked or couldn't check (\"I checked your sent mail\", \"I couldn't open the dashboard\").",
  "- one_next_step: it ends with exactly one next step for the person, or one thing the assistant can do if they reply.",
  'Answer with only JSON: {"stands_alone": true|false, "one_finding": true|false, "concrete_fact": true|false, "says_checked": true|false, "one_next_step": true|false}',
].join("\n");

export async function judgeMessage(model: ReplayModel, text: string): Promise<JudgeVerdict | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reply = await model({ messages: [{ role: "system", content: JUDGE_PROMPT }, { role: "user", content: `Message:\n"""\n${text}\n"""` }], tools: [] });
    const raw = reply.content ?? "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
      if (parsed.success) return { standsAlone: parsed.data.stands_alone, oneFinding: parsed.data.one_finding, concreteFact: parsed.data.concrete_fact, saysChecked: parsed.data.says_checked, oneNextStep: parsed.data.one_next_step };
    } catch {
      // Asked once more below.
    }
  }
  return null;
}

export type DayScore = {
  scenario: string;
  pipeline: Pipeline;
  messages: number;
  /** Must-tell items told in time, by id (and `id+again` for a required repeat). */
  told: Record<string, boolean>;
  missed: string[];
  /** Messages that interrupted for nothing required, for something never worth it, or as a repeat. */
  unwanted: { text: string; why: string }[];
  /** A quiet scenario that stayed quiet; null for the others. */
  correctSilence: boolean | null;
  checks: MessageChecks[];
  judged: (JudgeVerdict | null)[];
  error: string | null;
};

const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

export function scoreDay(scenario: DayScenario, run: DayRun): Omit<DayScore, "judged"> {
  const told: Record<string, boolean> = {};
  const unwanted: DayScore["unwanted"] = [];
  for (const item of scenario.expect.must) {
    const hits = run.messages.filter((message) => matches(item.match, message.text));
    told[item.id] = hits.some((message) => message.at <= Date.parse(item.by));
    if (item.again) {
      const after = Date.parse(item.again.after);
      const by = Date.parse(item.again.by);
      told[`${item.id}+again`] = hits.some((message) => message.at > after && message.at <= by);
    }
  }
  const counted = new Map<string, DeliveredMessage[]>();
  for (const message of run.messages) {
    const never = scenario.expect.never?.find((rule) => matches(rule.match, message.text));
    if (scenario.expect.silent) {
      unwanted.push({ text: message.text, why: "a quiet day" });
      continue;
    }
    const must = scenario.expect.must.filter((item) => matches(item.match, message.text));
    if (!must.length) {
      if (never) unwanted.push({ text: message.text, why: never.why });
      else if (!scenario.expect.ok?.some((rule) => matches(rule.match, message.text))) unwanted.push({ text: message.text, why: "nothing that needed Sam" });
      continue;
    }
    // A repeat of something already told counts against it, except the one required repeat (a nudge, "still unresolved").
    for (const item of must) {
      const seen = counted.get(item.id) ?? [];
      const limit = item.again ? 2 : 1;
      const inRepeatWindow = item.again ? message.at > Date.parse(item.again.after) && message.at <= Date.parse(item.again.by) : false;
      if (seen.length >= limit || (seen.length >= 1 && !inRepeatWindow)) unwanted.push({ text: message.text, why: `repeat about ${item.id}` });
      counted.set(item.id, [...seen, message]);
    }
  }
  const missed = Object.entries(told).filter(([, hit]) => !hit).map(([id]) => id);
  return {
    scenario: scenario.id,
    pipeline: run.pipeline,
    messages: run.messages.length,
    told,
    missed,
    unwanted: [...new Map(unwanted.map((entry) => [entry.text, entry])).values()],
    correctSilence: scenario.expect.silent ? run.messages.length === 0 : null,
    checks: run.messages.map((message) => measureMessage(message.text)),
    error: run.error,
  };
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

/** The report: totals per pipeline, then per scenario with what flipped between them. */
export function reportMarkdown(input: { scores: DayScore[]; scenarios: readonly DayScenario[]; runs: number; model: string; judgeModel: string; usage: Record<Pipeline, { check: { calls: number; input: number; cached: number; output: number; checks: number }; message: { calls: number; input: number; cached: number; output: number; checks: number } }> }): string {
  const { scores } = input;
  const by = (pipeline: Pipeline) => scores.filter((score) => score.pipeline === pipeline);
  const totals = (pipeline: Pipeline) => {
    const rows = by(pipeline);
    const mustTotal = rows.reduce((sum, row) => sum + Object.keys(row.told).length, 0);
    const missed = rows.reduce((sum, row) => sum + row.missed.length, 0);
    const unwanted = rows.reduce((sum, row) => sum + row.unwanted.length, 0);
    const silent = rows.filter((row) => row.correctSilence !== null);
    const checks = rows.flatMap((row) => row.checks);
    const judged = rows.flatMap((row) => row.judged).filter((verdict): verdict is JudgeVerdict => verdict !== null);
    const messages = rows.reduce((sum, row) => sum + row.messages, 0);
    const days = rows.reduce((sum, row) => sum + (input.scenarios.find((scenario) => scenario.id === row.scenario)?.windows.length ?? 1), 0);
    return {
      mustTotal, missed, unwanted, silentOk: silent.filter((row) => row.correctSilence).length, silentTotal: silent.length, messages, perDay: days ? (messages / days).toFixed(1) : "–",
      lead: pct(checks.filter((check) => check.leadOk).length, checks.length),
      length: pct(checks.filter((check) => check.lengthOk).length, checks.length),
      link: pct(checks.filter((check) => check.hasLink).length, checks.length),
      plain: pct(checks.filter((check) => check.plain).length, checks.length),
      medianChars: checks.length ? [...checks].sort((a, b) => a.chars - b.chars)[Math.floor(checks.length / 2)]?.chars ?? 0 : 0,
      standsAlone: pct(judged.filter((verdict) => verdict.standsAlone).length, judged.length),
      oneFinding: pct(judged.filter((verdict) => verdict.oneFinding).length, judged.length),
      fact: pct(judged.filter((verdict) => verdict.concreteFact).length, judged.length),
      checked: pct(judged.filter((verdict) => verdict.saysChecked).length, judged.length),
      nextStep: pct(judged.filter((verdict) => verdict.oneNextStep).length, judged.length),
      errors: rows.filter((row) => row.error).length,
    };
  };
  const old = totals("old");
  const neu = totals("new");
  const lines = [
    `Model ${input.model}, judge ${input.judgeModel}, ${input.runs} runs per scenario and pipeline, ${input.scenarios.length} scenarios.`,
    "",
    "| | Old prompts | New pipeline |",
    "| --- | --- | --- |",
    `| Missed important (of ${old.mustTotal}) | ${old.missed} | ${neu.missed} |`,
    `| Unwanted interruptions | ${old.unwanted} | ${neu.unwanted} |`,
    `| Correct silence (quiet days) | ${old.silentOk}/${old.silentTotal} | ${neu.silentOk}/${neu.silentTotal} |`,
    `| Messages (per scenario day) | ${old.messages} (${old.perDay}) | ${neu.messages} (${neu.perDay}) |`,
    `| Lead ≤ ~100 chars (≤ 120) | ${old.lead} | ${neu.lead} |`,
    `| Under ~350 chars (median) | ${old.length} (${old.medianChars}) | ${neu.length} (${neu.medianChars}) |`,
    `| Has a source link | ${old.link} | ${neu.link} |`,
    `| No headings, bullets, bold, emoji | ${old.plain} | ${neu.plain} |`,
    `| Judge: lead stands alone | ${old.standsAlone} | ${neu.standsAlone} |`,
    `| Judge: one finding per message | ${old.oneFinding} | ${neu.oneFinding} |`,
    `| Judge: concrete fact | ${old.fact} | ${neu.fact} |`,
    `| Judge: says what was checked | ${old.checked} | ${neu.checked} |`,
    `| Judge: one next step | ${old.nextStep} | ${neu.nextStep} |`,
    ...(old.errors + neu.errors ? [`| Runs that errored | ${old.errors} | ${neu.errors} |`] : []),
    "",
    "Per scenario (each cell over all runs: missed items, unwanted interruptions, messages):",
    "",
    "| Scenario | Old: missed / unwanted / msgs | New: missed / unwanted / msgs | Flips |",
    "| --- | --- | --- | --- |",
  ];
  for (const scenario of input.scenarios) {
    const rows = (pipeline: Pipeline) => scores.filter((score) => score.scenario === scenario.id && score.pipeline === pipeline);
    const cell = (pipeline: Pipeline) => {
      const list = rows(pipeline);
      return `${list.reduce((sum, row) => sum + row.missed.length, 0)} / ${list.reduce((sum, row) => sum + row.unwanted.length, 0)} / ${list.map((row) => row.messages).join("·")}`;
    };
    const flips: string[] = [];
    const ids = [...new Set(scores.filter((score) => score.scenario === scenario.id).flatMap((score) => Object.keys(score.told)))];
    for (const id of ids) {
      const rate = (pipeline: Pipeline) => rows(pipeline).filter((row) => row.told[id]).length;
      const before = rate("old");
      const after = rate("new");
      if (before !== after) flips.push(`${id} told ${before}/${rows("old").length} → ${after}/${rows("new").length}`);
    }
    const noise = (pipeline: Pipeline) => rows(pipeline).reduce((sum, row) => sum + row.unwanted.length, 0);
    if (noise("old") !== noise("new")) flips.push(`interruptions ${noise("old")} → ${noise("new")}`);
    if (scenario.expect.silent) {
      const quiet = (pipeline: Pipeline) => rows(pipeline).filter((row) => row.correctSilence).length;
      if (quiet("old") !== quiet("new")) flips.push(`silent ${quiet("old")}/${rows("old").length} → ${quiet("new")}/${rows("new").length}`);
    }
    lines.push(`| ${scenario.id} | ${cell("old")} | ${cell("new")} | ${flips.join("; ") || "none"} |`);
  }
  const usage = (pipeline: Pipeline) => input.usage[pipeline];
  const perCheck = (value: number, checks: number) => (checks ? Math.round(value / checks).toLocaleString("en-US") : "–");
  lines.push(
    "",
    "Tokens per check (average):",
    "",
    "| | Calls | Input | Cached input | Output |",
    "| --- | --- | --- | --- | --- |",
    `| Old: one turn | ${(usage("old").check.calls / Math.max(1, usage("old").check.checks)).toFixed(1)} | ${perCheck(usage("old").check.input, usage("old").check.checks)} | ${perCheck(usage("old").check.cached, usage("old").check.checks)} | ${perCheck(usage("old").check.output, usage("old").check.checks)} |`,
    `| New: step 1, the check | ${(usage("new").check.calls / Math.max(1, usage("new").check.checks)).toFixed(1)} | ${perCheck(usage("new").check.input, usage("new").check.checks)} | ${perCheck(usage("new").check.cached, usage("new").check.checks)} | ${perCheck(usage("new").check.output, usage("new").check.checks)} |`,
    `| New: step 2, the message (${usage("new").message.checks} of ${usage("new").check.checks} checks) | ${(usage("new").message.calls / Math.max(1, usage("new").message.checks)).toFixed(1)} | ${perCheck(usage("new").message.input, usage("new").message.checks)} | ${perCheck(usage("new").message.cached, usage("new").message.checks)} | ${perCheck(usage("new").message.output, usage("new").message.checks)} |`,
  );
  return lines.join("\n");
}
