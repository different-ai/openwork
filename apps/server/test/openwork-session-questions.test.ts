import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OpenWorkExtensionsPreview } from "../src/opencode-plugins/openwork-extensions-preview.js";
import { openworkReadTransport, type OpenworkReadTransport } from "../src/opencode-plugins/openwork-read-transport.js";
import { isQuestionReplyPath } from "../src/opencode-v2-context-bridge.js";

// A v1 host with one session waiting on a single-choice question and no
// desktop window: replies are recorded instead of sent.
function v1Host() {
  const replies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: OpenworkReadTransport = {
    engine: "v1",
    get: async (path) => {
      if (path === "/workspaces") return { items: [{ id: "ws1", name: "Enterprise" }] };
      if (path === "/workspace/ws1/opencode/session/s2") return { id: "s2", title: "Release" };
      if (path === "/workspace/ws1/opencode/question") {
        return [
          { id: "q1", sessionID: "s2", questions: [{ header: "Ship", question: "Ship now?", options: [{ label: "Yes" }, { label: "No" }], custom: false }] },
          { id: "q2", sessionID: "other", questions: [{ question: "Unrelated" }] },
        ];
      }
      throw new Error(`unexpected read ${path}`);
    },
    post: async (path, body) => {
      replies.push({ path, body });
      return true;
    },
  };
  return { transport, replies };
}

type Ask = (request: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
const allow: Ask = async () => {};

async function call(transport: OpenworkReadTransport, tool: "openwork_query" | "openwork_execute", id: string, args: Record<string, unknown>, sessionID = "s1", ask: Ask | null = allow) {
  const plugin = await OpenWorkExtensionsPreview();
  try {
    const raw = await openworkReadTransport.run(transport, () => plugin.tool[tool].execute({ id, args }, { sessionID, ...(ask ? { ask } : {}) }));
    return JSON.parse(String(raw));
  } finally {
    await plugin.dispose?.();
  }
}

test("a session's pending questions are listed and answered with the person's choice", async () => {
  const { transport, replies } = v1Host();
  const listed = await call(transport, "openwork_query", "session.question.list", { sessionId: "s2" });
  assert.deepEqual(listed.result.questions, [{
    requestId: "q1",
    questions: [{ header: "Ship", question: "Ship now?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiple: false, custom: false }],
  }]);
  const asked: Parameters<Ask>[0][] = [];
  const answered = await call(transport, "openwork_execute", "session.question.answer", { sessionId: "s2", requestId: "q1", answers: [["Yes"]] }, "s1", async (request) => {
    asked.push(request);
  });
  assert.equal(answered.result.ok, true, JSON.stringify(answered));
  assert.deepEqual(asked, [{
    permission: "openwork_session_question_answer", patterns: ["s2"], always: [],
    metadata: { sessionId: "s2", requestId: "q1", answers: [{ question: "Ship now?", answer: ["Yes"] }] },
  }]);
  assert.deepEqual(replies, [{ path: "/workspace/ws1/opencode/question/q1/reply", body: { answers: [["Yes"]] } }]);
});

test("an answer the person declines, or cannot be asked about, sends nothing", async () => {
  const { transport, replies } = v1Host();
  const args = { sessionId: "s2", requestId: "q1", answers: [["Yes"]] };
  const declined = await call(transport, "openwork_execute", "session.question.answer", args, "s1", async () => {
    throw new Error("The user rejected permission to use this specific tool call.");
  });
  assert.equal(declined.ok, false);
  assert.match(declined.error, /not answered: The user rejected/);
  const unaskable = await call(transport, "openwork_execute", "session.question.answer", args, "s1", null);
  assert.equal(unaskable.ok, false);
  assert.match(unaskable.error, /cannot ask for your approval/);
  assert.deepEqual(replies, []);
});

test("answers that do not fit the question, stale ids and a session's own question are refused", async () => {
  const { transport, replies } = v1Host();
  for (const [args, sessionID, error] of [
    [{ sessionId: "s2", requestId: "q1", answers: [["Maybe"]] }, "s1", /does not take "Maybe"/],
    [{ sessionId: "s2", requestId: "q1", answers: [["Yes", "No"]] }, "s1", /takes one answer/],
    [{ sessionId: "s2", requestId: "q1", answers: [["Yes"], ["No"]] }, "s1", /one per question/],
    [{ sessionId: "s2", requestId: "q9", answers: [["Yes"]] }, "s1", /no longer pending/],
    [{ sessionId: "s2", requestId: "q1", answers: [["Yes"]] }, "s2", /its own question/],
  ] as const) {
    const refused = await call(transport, "openwork_execute", "session.question.answer", args, sessionID);
    assert.equal(refused.ok, false, JSON.stringify(args));
    assert.match(refused.error, error);
  }
  assert.deepEqual(replies, []);
});

/** The engine's permission and event routes; the person answers each prompt with `reply`. */
async function fakeEngine(reply: "once" | "reject") {
  const asked: Array<Record<string, unknown>> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      asked.push(JSON.parse(text));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "per_one", effect: "ask" } }));
      setTimeout(() => {
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "permission.replied", data: { requestID: "per_one", reply } })}\n\n`);
      }, 20);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    asked, connection: { url: `http://127.0.0.1:${port}`, username: "opencode", password: "secret" },
    close: () => { for (const stream of streams) stream.end(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function answerThroughBridge(reply: "once" | "reject") {
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  const replies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const engine = await fakeEngine(reply);
  const bridge = await createV2ContextBridge(async (path, init) => {
    if (path === "/workspaces") return { items: [{ id: "ws1", name: "Enterprise" }] };
    if (path === "/workspace/ws1/opencode2/api/session/s2") return { data: { id: "s2", title: "Release" } };
    if (path === "/workspace/ws1/opencode2/api/session/s2/form") {
      return { data: [{
        id: "f1", sessionID: "s2", metadata: { kind: "question" },
        fields: [
          { key: "target", type: "multiselect", title: "Targets", options: [{ label: "macOS", value: "mac" }, { label: "Windows", value: "win" }] },
          { key: "note", type: "string", title: "Note" },
        ],
      }] };
    }
    if (init?.method === "POST") {
      replies.push({ path, body: JSON.parse(String(init.body)) });
      return {};
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  }, () => engine.connection);
  const post = async (name: string, input: unknown) => {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input, sessionId: "s1", caller: { directory: "/work", messageId: "msg_one", callId: "call_one" } }),
    });
    return response.json();
  };
  try {
    const listed = await post("openwork_query", { id: "session.question.list", args: { sessionId: "s2" } });
    const answered = await post("openwork_execute", {
      id: "session.question.answer", args: { sessionId: "s2", requestId: "f1", answers: [["macOS", "Windows"], ["After the freeze"]] },
    });
    return { listed, answered, replies, asked: engine.asked };
  } finally {
    await bridge.close();
    await engine.close();
  }
}

test("the v2 bridge answers a question form by field key and option value once the person allows it", async () => {
  const { listed, answered, replies, asked } = await answerThroughBridge("once");
  assert.equal(listed.result.questions[0].requestId, "f1", JSON.stringify(listed));
  assert.deepEqual(listed.result.questions[0].questions.map((question: { multiple: boolean }) => question.multiple), [true, false]);
  assert.equal(answered.result.ok, true, JSON.stringify(answered));
  assert.deepEqual(asked.map(({ action, resources, save, source }) => ({ action, resources, save, source })), [{
    action: "openwork_session_question_answer", resources: ["s2"], save: [], source: { type: "tool", messageID: "msg_one", id: "call_one" },
  }]);
  assert.deepEqual(replies, [{
    path: "/workspace/ws1/opencode2/api/session/s2/form/f1/reply",
    body: { answer: { target: ["mac", "win"], note: "After the freeze" } },
  }]);
});

test("a v2 answer the person declines sends nothing", async () => {
  const { answered, replies } = await answerThroughBridge("reject");
  assert.equal(answered.ok, false, JSON.stringify(answered));
  assert.match(answered.error, /declined answering this question, so the question was not answered/);
  assert.deepEqual(replies, []);
});

test("the v2 bridge writes only question-form reply routes for answers", () => {
  assert.equal(isQuestionReplyPath("/workspace/ws1/opencode2/api/session/s2/form/f1/reply"), true);
  for (const path of [
    "/workspace/ws1/opencode2/api/session/s2/form/f1",
    "/workspace/ws1/opencode2/api/session/s2/form/f1/reply?x=1",
    "/workspace/ws1/opencode2/api/session/s2/form/../prompt/reply",
    "/workspace/ws1/opencode2/api/session/s2/prompt",
  ]) assert.equal(isQuestionReplyPath(path), false, path);
});

test("a wrong argument name is refused with the valid names, instead of being dropped", async () => {
  const { transport } = v1Host();
  const listed = await call(transport, "openwork_query", "session.question.list", { sessionId: "s2", limit: 5 });
  assert.equal(listed.ok, false, JSON.stringify(listed));
  assert.equal(listed.error, 'Unknown argument "limit". Valid arguments: sessionId, workspaceId.');
});
