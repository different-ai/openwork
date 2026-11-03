import { describe, expect, test } from "vitest";
import { answerTool, chatCompletionsModel, replayPrompt, runReplay, scoreReplay, type ReplayModel } from "./harness.ts";
import { REPLAY_TIMELINES } from "./timelines.ts";

// The replay harness itself, with a scripted model: the timelines' tools answer like Connect, the real wake prompt and
// reply parser are used, and the scorer catches the failures the live runs look for. The live runs are agent-replay.ts.

function timeline(id: string) {
  const found = REPLAY_TIMELINES.find((entry) => entry.id === id);
  if (!found) throw new Error(`No timeline ${id}`);
  return found;
}

/** A model that makes the given tool calls, then answers. */
function scripted(calls: { name: string; args: Record<string, unknown> }[], answer: string): ReplayModel {
  let step = 0;
  return async ({ messages }) => {
    step += 1;
    if (step === 1 && calls.length) {
      return { content: null, tool_calls: calls.map((call, index) => ({ id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
    }
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(calls.length);
    return { content: answer };
  };
}

describe("agent replay harness", () => {
  test("the prompt is Den's real wake prompt: calendar, email and team chat with their last read", () => {
    const prompt = replayPrompt(timeline("slack-ask-before-call"));
    expect(prompt).toMatch(/^\[wake\] Scheduled check\. It is Tue, Oct 20, 9:40 AM \(America\/New_York\)\./);
    expect(prompt).toMatch(/- email: Email through Gmail: their inbox\. last read today at 8:05 AM \(Gmail search after:\d+\)\./);
    expect(prompt).toMatch(/- chat: Team chat through Slack: DMs to them, mentions of them and threads they're in\. last read today at 8:05 AM \(Slack search after:2026-10-19/);
  });

  test("tools answer from the timeline like Connect: a calendar window, Gmail and Slack since a time, threads, notes", () => {
    const ask = timeline("slack-ask-before-call");
    const files = new Map<string, string>();
    const events = JSON.parse(answerTool(ask, files, "google_calendar_list_events", JSON.stringify({ timeMin: "2026-10-20T10:30:00-04:00", timeMax: "2026-10-20T23:59:00-04:00" })));
    expect(events.items.map((entry: { id: string }) => entry.id)).toEqual(["evt_renewal"]);
    const mail = JSON.parse(answerTool(ask, files, "gmail_search_threads", JSON.stringify({ query: `after:${Date.parse("2026-10-20T08:05:00-04:00") / 1000}` })));
    expect(mail.threads.map((entry: { id: string }) => entry.id)).toEqual(["thr_digest"]);
    const chat = JSON.parse(answerTool(ask, files, "slack_search_public_and_private", JSON.stringify({ query: "after:2026-10-19" })));
    expect(chat.messages[0].text).toMatch(/pricing for 60 seats/);
    const handled = timeline("already-handled");
    const thread = JSON.parse(answerTool(handled, files, "slack_read_thread", JSON.stringify({ channel_id: "C0TAILSPIN", message_ts: "1792519200.000400" })));
    expect(thread.messages.map((entry: { text: string }) => entry.text).at(-1)).toBe("Got it, thanks!");
    answerTool(ask, files, "write_file", JSON.stringify({ path: "memory/notes.md", content: "told: pricing ask" }));
    expect(answerTool(ask, files, "read_file", JSON.stringify({ path: "memory/notes.md" }))).toBe("told: pricing ask");
    expect(JSON.parse(answerTool(ask, files, "slack_send_message", "{}"))).toEqual({ error: "unknown_tool" });
  });

  test("a message that connects the Slack ask to the call passes", async () => {
    const ask = timeline("slack-ask-before-call");
    const answer = JSON.stringify({
      message: "Before your 11 AM Fabrikam renewal call: Priya asked in Slack for pricing on 60 seats, annual plan, because their CFO is joining. I haven't found a quote in your email. Send the numbers before 11. <https://northwind.slack.com/archives/C0FABRIKAM/p1792502520000100|Slack message>",
      items: [{ source: "chat", id: "https://northwind.slack.com/archives/C0FABRIKAM/p1792502520000100", preset: "meeting_prep" }],
    });
    const run = await runReplay(ask, scripted([{ name: "slack_search_public_and_private", args: { query: "after:2026-10-19" } }, { name: "google_calendar_list_events", args: { timeMin: "2026-10-20T09:40:00-04:00", timeMax: "2026-10-21T23:59:00-04:00" } }], answer));
    expect(run.toolCalls).toEqual(["slack_search_public_and_private", "google_calendar_list_events"]);
    expect(scoreReplay(ask, run)).toMatchObject({ pass: true, reply: "message", failures: [] });
  });

  test("the old report voice fails: a category label, a stock draft offer, and the email instead of the Slack ask", async () => {
    const ask = timeline("slack-ask-before-call");
    const answer = JSON.stringify({ message: "Today:\n- Fabrikam renewal call at 11 AM\nFYI: weekly digest\nWant me to draft replies in Workbot?", items: [{ responsibility: "morning_brief", ref: "brief:2026-10-20" }] });
    const verdict = scoreReplay(ask, await runReplay(ask, scripted([], answer)));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toEqual(expect.arrayContaining([
      "items should include chat",
      "style: no category labels",
      "style: no generic draft offer",
      expect.stringMatching(/^should say what was asked \(pricing\)/),
      expect.stringMatching(/^should say a link to the Slack message/),
    ]));
  });

  test("quiet timelines pass only with NO_REPLY; an unparsable answer is never a pass", async () => {
    const quiet = timeline("quiet-afternoon");
    expect(scoreReplay(quiet, await runReplay(quiet, scripted([], "NO_REPLY"))).pass).toBe(true);
    const chatty = await runReplay(quiet, scripted([], JSON.stringify({ message: "Quick check: you got a receipt.", items: [{ source: "email", id: "thr_receipt" }] })));
    expect(scoreReplay(quiet, chatty)).toMatchObject({ pass: false, reply: "message" });
    const ask = timeline("slack-ask-before-call");
    expect(scoreReplay(ask, await runReplay(ask, scripted([], "Here is what I found")))).toMatchObject({ pass: false, reply: "invalid" });
  });

  test("the live model speaks OpenAI-compatible chat completions with the timeline's tools", async () => {
    const requests: unknown[] = [];
    const fake: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "gmail_search_threads", arguments: "{\"query\":\"after:1\"}" } }] } }] }), { status: 200 });
    };
    const model = chatCompletionsModel({ baseUrl: "https://models.example/v1/", apiKey: "test-key", model: "test-model", fetch: fake });
    const answer = await model({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(answer.tool_calls?.[0]?.function.name).toBe("gmail_search_threads");
    expect(requests[0]).toMatchObject({ model: "test-model", tool_choice: "auto" });
  });

  test("every timeline is fictional: example domains only, no real workspace or person", () => {
    for (const entry of REPLAY_TIMELINES) {
      const text = JSON.stringify(entry);
      const domains = [...text.matchAll(/@([a-z0-9.-]+)/g)].map((match) => match[1]);
      for (const domain of domains) expect(domain === "sam" || domain?.endsWith(".example"), `${entry.id}: ${domain}`).toBe(true);
    }
  });
});
