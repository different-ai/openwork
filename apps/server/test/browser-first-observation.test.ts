import assert from "node:assert/strict";
import { test } from "node:test";
import { server, withFirstObservation } from "../src/opencode-plugins/openwork-chrome-devtools.js";

type Call = { operation: string; args: Record<string, unknown>; sessionId: string };

function recorder(observation: unknown) {
  const calls: Call[] = [];
  return {
    calls,
    request: async (call: Call) => {
      calls.push(call);
      if (observation instanceof Error) throw observation;
      return observation;
    },
  };
}

const opened = { ok: true, provider: "builtin", tabId: "tab_1", url: "https://example.com/", visible: true, next: "observe" };
const call = { operation: "open", args: { url: "https://example.com/" }, sessionId: "ses_1" };

test("open returns the page's controls so the agent can act next", async () => {
  const observation = { ok: true, observationId: "obs_1", controls: [{ ref: "e1", role: "button", name: "Sign up" }] };
  const { calls, request } = recorder(observation);
  const result = await withFirstObservation(opened, call, request);
  assert.deepEqual(calls, [{ operation: "observe", args: { tabId: "tab_1", mode: "interactive" }, sessionId: "ses_1" }]);
  assert.deepEqual(result, { ...opened, next: "act", observation });
});

test("a failed read keeps the open result and its observe hint", async () => {
  const paused = { ok: false, code: "paused", error: "The user has browser control." };
  const { request } = recorder(paused);
  assert.deepEqual(await withFirstObservation(opened, call, request), { ...opened, observation: paused });

  const thrown = recorder(new Error("bridge closed"));
  assert.deepEqual(await withFirstObservation(opened, call, thrown.request), opened);
});

test("failed opens are not observed", async () => {
  const blocked = { ok: false, code: "website_blocked", error: "Your organization does not allow this website." };
  const { calls, request } = recorder({ ok: true });
  assert.deepEqual(await withFirstObservation(blocked, call, request), blocked);
  assert.deepEqual(calls, []);
});

test("open and navigate offer observe; other tools do not", async () => {
  const { tool } = await server();
  assert.ok("observe" in tool.browser_open.args);
  assert.ok("observe" in tool.browser_navigate.args);
  assert.ok(!("observe" in tool.browser_act.args));
  assert.match(tool.browser_open.description, /act on it next with browser_act; do not observe again first/);
});
