import { describe, expect, test } from "vitest";
import { answerDayTool, calendarAt, memorySection } from "./day.ts";
import { DAY_SCENARIOS } from "./day-scenarios.ts";
import type { ReplayModel } from "./harness.ts";
import { runNewPipeline, runOldPipeline } from "./pipelines.ts";
import { firstSentence, measureMessage, reportMarkdown, scoreDay, visibleText } from "./score.ts";

// The brief replay harness with scripted models: the world answers by time, both pipelines run their real prompts,
// parsers and limits, and the scorer catches what the live runs look for. The live runs are agent-brief-replay.ts.

function scenario(id: string) {
  const found = DAY_SCENARIOS.find((entry) => entry.id === id);
  if (!found) throw new Error(`No scenario ${id}`);
  return found;
}

/** Answers step 1 with `check`, step 2 with `message`, and today's turn with `legacy`; counts calls. */
function scripted(answers: { check?: string; message?: string; legacy?: string }) {
  const calls = { check: 0, message: 0, legacy: 0 };
  const model: ReplayModel = async ({ messages }) => {
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    if (system.includes("running a scheduled check in the background")) {
      calls.check += 1;
      return { content: answers.check ?? "NO_FINDINGS", usage: { input: 100, cached: 50, output: 10 } };
    }
    if (system.includes("You have no tools in this step")) {
      calls.message += 1;
      return { content: answers.message ?? "NO_REPLY", usage: { input: 20, cached: 0, output: 5 } };
    }
    calls.legacy += 1;
    return { content: answers.legacy ?? "NO_REPLY" };
  };
  return { model, calls };
}

describe("brief replay harness", () => {
  test("the world answers by time: an item is invisible before it happened, a moved meeting shows its newest version", () => {
    const ask = scenario("slack-ask-before-meeting");
    const before = JSON.parse(answerDayTool(ask, Date.parse("2026-10-21T09:00:00-04:00"), new Map(), { id: "1", type: "function", function: { name: "slack_search_public_and_private", arguments: "{}" } }) ?? "{}");
    const after = JSON.parse(answerDayTool(ask, Date.parse("2026-10-21T09:30:00-04:00"), new Map(), { id: "1", type: "function", function: { name: "slack_search_public_and_private", arguments: "{}" } }) ?? "{}");
    expect(before.messages.some((message: { text: string }) => message.text.includes("60 seats"))).toBe(false);
    expect(after.messages.some((message: { text: string }) => message.text.includes("60 seats"))).toBe(true);
    const conflict = scenario("calendar-change-conflict");
    expect(calendarAt(conflict, Date.parse("2026-10-21T09:00:00-04:00")).find((event) => event.id === "evt_review")?.start).toBe("2026-10-22T10:00:00-04:00");
    expect(calendarAt(conflict, Date.parse("2026-10-21T10:00:00-04:00")).find((event) => event.id === "evt_review")?.start).toBe("2026-10-21T15:00:00-04:00");
    expect(memorySection(new Map([["memory/notes.md", "x"], ["drafts/a.md", "y"]]))).toBe("# Your memory (files under memory/)\n\n## memory/notes.md\nx");
  });

  test("new pipeline: NO_FINDINGS at every check means no message turn and a correct silence", async () => {
    const quiet = scenario("quiet-day");
    const { model, calls } = scripted({});
    const run = await runNewPipeline(quiet, model);
    expect(run.checks.map((check) => [new Date(check.at).toISOString(), check.occasion])).toEqual([
      ["2026-10-21T12:00:00.000Z", "first"], ["2026-10-21T14:00:00.000Z", "scheduled"], ["2026-10-21T16:00:00.000Z", "scheduled"], ["2026-10-21T18:00:00.000Z", "scheduled"],
    ]);
    expect(calls).toMatchObject({ check: 4, message: 0 });
    expect(scoreDay(quiet, run)).toMatchObject({ correctSilence: true, unwanted: [], missed: [] });
  });

  test("new pipeline: a P0 report goes to the messenger once; Den's told-once keeps the next checks from repeating it", async () => {
    const ask = scenario("slack-ask-before-meeting");
    const message = JSON.stringify({ messages: [{ text: "Before your 11 AM with Fabrikam: Priya asked for pricing on 60 seats. I checked your sent mail. Send the numbers. <https://acme.slack.com/archives/C0FABRIKAM/p1792588920000100|Slack message>", about: ["chat:https://acme.slack.com/archives/C0FABRIKAM/p1792588920000100"] }] });
    const { model, calls } = scripted({ check: "P0 — Priya asked for pricing. ids: chat:https://acme.slack.com/archives/C0FABRIKAM/p1792588920000100", message });
    const run = await runNewPipeline(ask, model);
    expect(run.messages).toHaveLength(1);
    expect(calls.message).toBe(2);
    expect(run.checks.map((check) => check.outcome)).toEqual(["sent", "already_told"]);
    const score = scoreDay(ask, run);
    expect(score).toMatchObject({ missed: [], unwanted: [] });
    expect(run.checks[0]?.usage.check).toEqual({ calls: 1, input: 100, cached: 50, output: 10 });
  });

  test("old pipeline: a morning pass, about every three hours, and a meeting wake 15 minutes before a call with outsiders", async () => {
    const ask = scenario("slack-ask-before-meeting");
    const { model } = scripted({});
    const run = await runOldPipeline(ask, model);
    expect(run.checks.map((check) => [new Date(check.at).toISOString(), check.occasion])).toEqual([
      ["2026-10-21T12:00:00.000Z", "morning"], ["2026-10-21T14:45:00.000Z", "calendar"], ["2026-10-21T15:00:00.000Z", "scheduled"],
    ]);
  });

  test("scoring: missed, late, repeats and noise; measured writing rules", () => {
    const busy = scenario("busy-morning");
    const at = (time: string) => Date.parse(`2026-10-21T${time}:00-04:00`);
    const score = scoreDay(busy, {
      scenario: busy.id, pipeline: "new", error: null, checks: [],
      messages: [
        { at: at("08:00"), text: "Dana needs the countersigned SOW by noon. I checked your sent mail. Send it before noon. <https://mail.google.com/x|Email thread>" },
        { at: at("10:00"), text: "Still unresolved: the SOW. <https://mail.google.com/x|Email thread>" },
        { at: at("12:00"), text: "This week in robotics is out." },
      ],
    });
    expect(score.missed).toEqual(["priya-invite", "bandwidth"]);
    expect(score.unwanted.map((entry) => entry.why)).toEqual(["repeat about sow", "newsletters and routine notifications"]);
    expect(firstSentence("Before your 11 AM: Priya asked. More.")).toBe("Before your 11 AM: Priya asked.");
    expect(visibleText("See <https://x.example/a|Email thread>.")).toBe("See Email thread.");
    expect(measureMessage("**Today:**\n- one")).toMatchObject({ plain: false, hasLink: false });
    const report = reportMarkdown({ scores: [{ ...score, judged: [] }], scenarios: [busy], runs: 1, model: "m", judgeModel: "j", usage: { old: { check: { calls: 0, input: 0, cached: 0, output: 0, checks: 0 }, message: { calls: 0, input: 0, cached: 0, output: 0, checks: 0 } }, new: { check: { calls: 3, input: 300, cached: 0, output: 30, checks: 3 }, message: { calls: 1, input: 10, cached: 0, output: 1, checks: 1 } } } });
    expect(report).toContain("| busy-morning |");
  });

  test("every scenario is fictional: example domains only", () => {
    for (const entry of DAY_SCENARIOS) {
      const text = JSON.stringify(entry);
      for (const match of text.matchAll(/@([a-z0-9-]+\.[a-z0-9.-]+)/g)) expect(match[1]?.endsWith(".example"), `${entry.id}: ${match[1]}`).toBe(true);
      for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+)\//g)) expect(match[1], entry.id).toMatch(/\.example$|^acme\.slack\.com$|^mail\.google\.com$|^calendar\.google\.com$|^github\.com$/);
    }
  });
});
