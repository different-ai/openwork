import { afterEach, expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import type { ComputerRequest } from "@openwork/types/desktop-ipc";
import { useComputerStore } from "../src/react-app/domains/session/computer/computer-store";
import { dismissSessionQuestion, submitAfterDismissingSessionQuestions } from "../src/react-app/domains/session/sync/session-question-dismissal";
import { permissionKey, questionKey } from "../src/react-app/domains/session/sync/session-sync";

const workspaceId = "ws_steering";
const sessionId = "ses_target";
const other = "ses_other";
const directory = "/fixture/workspace";
const prompt = { header: "Format", question: "Which format?", options: [{ label: "Video", description: "Short" }] };
const first = { id: "que_first", sessionID: sessionId, questions: [prompt] };
const second = { id: "que_second", sessionID: sessionId, questions: [prompt] };
const unrelated = { id: "que_other", sessionID: other, questions: [prompt] };
const privateDecision = { id: "que_private", sessionID: sessionId, questions: [{
  header: "Connection", question: "Connect the service?", options: [{ label: "Authenticate" }, { label: "Skip" }], multiple: false, custom: false,
}] };
const permission = [{ id: "per_untouched", sessionID: sessionId }];
const privateValue: ComputerRequest = {
  id: "private_value", reason: "credential", computer: "Fixture computer", placement: "local",
  credential: { fills: [{ field: "reference", ask: "Synthetic value" }] },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  useComputerStore.getState().setRequest(sessionId, null);
  const cache = getReactQueryClient();
  cache.removeQueries({ queryKey: questionKey(workspaceId, sessionId) });
  cache.removeQueries({ queryKey: questionKey(workspaceId, other) });
  cache.removeQueries({ queryKey: permissionKey(workspaceId, sessionId) });
});

function useFetch(respond: (request: Request) => Response | Promise<Response>) {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(new Request(input, init)),
    { preconnect: originalFetch.preconnect });
}

function seedCache() {
  const cache = getReactQueryClient();
  cache.setQueryData(questionKey(workspaceId, sessionId), [first, second, privateDecision]);
  cache.setQueryData(questionKey(workspaceId, other), [unrelated]);
  cache.setQueryData(permissionKey(workspaceId, sessionId), permission);
  useComputerStore.getState().setRequest(sessionId, privateValue);
  return cache;
}

function v1() {
  return { client: createClient("http://fixture.invalid/opencode", directory), workspaceId, sessionId, directory };
}

const current = () => {};

test("steer waits for both runtime dismissals and leaves another conversation, permission and private decision untouched", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runtime = new Map([first, second, unrelated, privateDecision].map(question => [question.id, question]));
  const events: string[] = [];
  useFetch(async request => {
    const { pathname, searchParams } = new URL(request.url);
    expect(searchParams.get("directory")).toBe(directory);
    if (request.method === "GET" && pathname === "/opencode/question") {
      events.push("list");
      return Response.json([...runtime.values()]);
    }
    const id = pathname.match(/^\/opencode\/question\/(que_first|que_second)\/reject$/)?.[1];
    if (request.method !== "POST" || !id) throw new Error(`Unexpected request ${request.method} ${pathname}`);
    events.push(`reject:${id}`);
    if (id === first.id) {
      entered.resolve();
      await release.promise;
    }
    expect(runtime.delete(id)).toBeTrue();
    return Response.json(true);
  });
  const cache = seedCache();
  const sending = submitAfterDismissingSessionQuestions(v1(), current, async () => {
    events.push("steer");
    expect([...runtime.keys()]).toEqual([unrelated.id, privateDecision.id]);
    return "delivered";
  }, async () => { throw new Error("A steer dismissing a question must not interrupt the run"); });
  try {
    await entered.promise;
    expect(events).toEqual(["list", `reject:${first.id}`]);
    expect(cache.getQueryData(questionKey(workspaceId, sessionId))).toEqual([first, second, privateDecision]);
  } finally {
    release.resolve();
  }
  expect(await sending).toBe("delivered");
  expect(events).toEqual(["list", `reject:${first.id}`, `reject:${second.id}`, "steer"]);
  expect(cache.getQueryData(questionKey(workspaceId, sessionId))).toEqual([privateDecision]);
  expect(cache.getQueryData(questionKey(workspaceId, other))).toEqual([unrelated]);
  expect(cache.getQueryData(permissionKey(workspaceId, sessionId))).toEqual(permission);
  expect(useComputerStore.getState().requests[sessionId]).toBe(privateValue);
});

for (const stillPending of [false, true]) {
  test(`a failed dismissal ${stillPending ? "does not deliver when still pending" : "still delivers after a fresh read confirms the question is gone"}`, async () => {
    const rereadEntered = Promise.withResolvers<void>();
    const rereadRelease = Promise.withResolvers<void>();
    const events: string[] = [];
    useFetch(async request => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/opencode/question") {
        const firstRead = events.length === 0;
        events.push("list");
        if (firstRead) return Response.json([first, second]);
        rereadEntered.resolve();
        await rereadRelease.promise;
        return Response.json(stillPending ? [first, second] : [second]);
      }
      events.push(path);
      if (path.endsWith(`${first.id}/reject`)) return Response.json({ name: "QuestionNotFound" }, { status: 404 });
      if (path.endsWith(`${second.id}/reject`)) return Response.json(true);
      throw new Error(`Unexpected request ${request.method} ${path}`);
    });
    const cache = seedCache();
    const sending = submitAfterDismissingSessionQuestions(v1(), current, async () => { events.push("steer"); return "delivered"; });
    const done = sending.then(value => ({ value }), (error: Error) => ({ error: error.message }));
    try {
      await rereadEntered.promise;
      expect(events).toEqual(["list", `/opencode/question/${first.id}/reject`, "list"]);
    } finally {
      rereadRelease.resolve();
    }
    if (stillPending) expect(await done).toEqual({ error: expect.stringContaining("QuestionNotFound") });
    else expect(await done).toEqual({ value: "delivered" });
    expect(events.slice(3)).toEqual(stillPending ? [] : [`/opencode/question/${second.id}/reject`, "steer"]);
    expect(cache.getQueryData(questionKey(workspaceId, sessionId))).toEqual(stillPending ? [first, second, privateDecision] : [privateDecision]);
  });
}

test("a steer with no question preserves the ordinary dispatch path", async () => {
  useFetch(request => {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/opencode/question");
    return Response.json([unrelated]);
  });
  const result = await submitAfterDismissingSessionQuestions(v1(), current,
    async () => { throw new Error("No question was available to dismiss"); }, async () => "unchanged dispatch");
  expect(result).toBe("unchanged dispatch");
});

test("a question that went away before the initial runtime read does not cause an interrupt", async () => {
  const cache = seedCache();
  useFetch(request => {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/opencode/question");
    return Response.json([unrelated]);
  });
  const result = await submitAfterDismissingSessionQuestions(v1(), current, async () => "delivered",
    async () => { throw new Error("The cached question must not cause an interrupt"); });
  expect(result).toBe("delivered");
  expect(cache.getQueryData(questionKey(workspaceId, sessionId))).toEqual([privateDecision]);
});

test("native v2 steer and manual Dismiss use the same session-scoped form deletion", async () => {
  const context = { ...v1(), client: createClientV2("http://fixture.invalid/opencode2", directory, {}) };
  const path = `/opencode2/api/session/${sessionId}/form`;
  const form = { id: first.id, sessionID: sessionId, metadata: { kind: "question" }, fields: [{
    key: "format", type: "string", title: "Which format?", options: [{ value: "video", label: "Video" }],
  }] };
  const events: string[] = [];
  useFetch(request => {
    const requestPath = new URL(request.url).pathname;
    events.push(`${request.method} ${requestPath}`);
    if (requestPath === path && request.method === "GET") return Response.json({ data: [form] });
    if (requestPath === `${path}/${first.id}` && request.method === "GET") return Response.json({ data: form });
    if (requestPath === `${path}/${first.id}` && request.method === "DELETE") return Response.json({ data: true });
    throw new Error(`Unexpected request: ${request.method} ${requestPath}`);
  });
  await dismissSessionQuestion(context, first.id);
  await submitAfterDismissingSessionQuestions(context, current, async () => { events.push("steer"); });
  expect(events).toEqual([`GET ${path}/${first.id}`, `DELETE ${path}/${first.id}`, `GET ${path}`, `DELETE ${path}/${first.id}`, "steer"]);
});
