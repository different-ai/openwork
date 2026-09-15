import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeV2PartId, type NativeV2Message, type NativeV2Session } from "@openwork/headless-threads/v2";
import { readExecutionActivity } from "./progress-activity.ts";
import { PROGRESS_LIMITS } from "./progress-config.ts";
import { createCoworkerThreads } from "./threads.ts";
import type { StreamEvent } from "./live-stream.ts";

test("activity reads native v2 history with verified attribution, bounded visible text and real tool times", async (t) => {
  const model = { providerID: "fixture", id: "fixture" };
  const session: NativeV2Session = { id: "ses_fixture", location: { directory: "/fixture" }, projectID: "fixture", model, agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 3 } };
  const user: NativeV2Message = { type: "user", id: "msg_input", text: "Fixture", time: { created: 1 }, metadata: { headlessTurn: { version: 1, messageId: "msg_input", contextId: null, previousMessageId: null, previousIdleAt: null, previousOutcome: null, model, agent: "build" } } };
  const reply: NativeV2Message = { type: "assistant", id: "msg_reply", time: { created: 2 }, model, agent: "build", content: [
    { type: "reasoning", text: "Must not appear" },
    { type: "text", text: "Visible reply" },
    { type: "tool", id: "call_fixture", name: "read", time: { created: 2, ran: 3, completed: 4 }, state: { status: "completed", input: { path: "private" }, content: [{ type: "text", text: "Must not appear" }] } },
  ] };
  let history: NativeV2Message[] = [user, reply];
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/message")) return Response.json({ data: history, cursor: { previous: null, next: null } });
    if (path.endsWith("/inbox")) return Response.json({ data: [] });
    if (path.endsWith("/active")) return Response.json({ data: { ses_fixture: { type: "running" } } });
    if (path.endsWith("/ses_fixture")) return Response.json({ data: session });
    throw new Error(`Unexpected route: ${path}`);
  });
  const input = { serverUrl: "http://fixture.invalid", workspaceId: "ws_fixture", token: "fixture", threadId: "ses_fixture", messageId: "msg_input", signal: AbortSignal.timeout(5_000) };
  const activity = await readExecutionActivity(input);
  assert.equal(activity.nativeStatus, "busy");
  assert.deepEqual(activity.replies, [{ id: "msg_reply", parentId: "msg_input", parts: [{ id: nativeV2PartId("msg_reply", 0), text: "Visible reply", ended: false }] }]);
  assert.equal(activity.completedSteps, 1);
  assert.equal(activity.tools[0]?.startedAt, 3);
  assert.equal(activity.tools[0]?.completedAt, 4);
  assert.ok(!JSON.stringify(activity).includes("Must not appear"));
  assert.ok(!JSON.stringify(activity).includes("private"));
  history = [user, { ...reply, content: [{ type: "text", text: "x".repeat(PROGRESS_LIMITS.maxReplyChars + 1) }] }];
  assert.equal((await readExecutionActivity(input)).replies[0]?.parts[0]?.text.length, PROGRESS_LIMITS.maxReplyChars);
  history = [{ ...user, metadata: {} }, reply];
  await assert.rejects(readExecutionActivity(input), /attribution could not be verified/);
  history = [user, { type: "synthetic", id: "msg_unknown", text: "Unowned context", time: { created: 2 } }, reply];
  await assert.rejects(readExecutionActivity(input), /attribution could not be verified/);
  assert.ok(paths.every((path) => path.startsWith("/workspace/ws_fixture/opencode2/api/")));
});

test("the renderer subscription refreshes mid-stream native history and preserves part identity", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(new URL(String(input)).pathname, "/workspace/ws_fixture/opencode2/api/event");
    const data = { sessionID: "ses_fixture", assistantMessageID: "msg_reply", ordinal: 0 };
    const events = [
      { id: "evt_delta_1", type: "session.text.delta", data: { ...data, delta: "Visible " } },
      { id: "evt_delta_2", type: "session.text.delta", data: { ...data, delta: "reply" } },
      { id: "evt_end", type: "session.text.ended", data: { ...data, text: "Visible reply" } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const threads = createCoworkerThreads({ serverUrl: "http://fixture.invalid", workspaceId: "ws_fixture", token: "fixture" });
  const events: StreamEvent[] = [];
  let refreshes = 0;
  let refreshesBeforeEnd = 0;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native text events did not arrive.")), 1_000);
    const unsubscribe = threads.subscribe(() => { refreshes += 1; }, (event) => {
      events.push(event);
      if (event.kind === "part" && event.ended) { refreshesBeforeEnd = refreshes; clearTimeout(timeout); unsubscribe(); resolve(); }
    });
    t.after(() => { clearTimeout(timeout); unsubscribe(); });
  });
  assert.ok(refreshesBeforeEnd > 0, "delta-only reconnects must refresh attribution before the reply ends");
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.messageId === "msg_reply" && event.partId === nativeV2PartId("msg_reply", 0)));
  assert.deepEqual(events[1], { kind: "delta", threadId: "ses_fixture", messageId: "msg_reply", partId: nativeV2PartId("msg_reply", 0), delta: "reply" });
});
