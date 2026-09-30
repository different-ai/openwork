import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJevVerificationEvaluator } from "../src/verification-jev.ts";
import { compileVerification } from "../src/verification.ts";
import type { VerificationEvaluationRequest } from "../src/verification.ts";

const request: VerificationEvaluationRequest = {
  state: { intent: "Check synthetic count", dictionary: { id: "synthetic", version: "1", checks: [] } },
  questions: { coverage: { type: "boolean", instructions: "Is it covered?" } },
  signal: new AbortController().signal,
};
const answers = { coverage: { type: "boolean", probability: 1 } };
const unavailable = { message: "Jev verification evaluation unavailable" };

test("missing key fails before fetch; environment key is accepted", async () => {
  const previous = process.env.JEV_AI_GATEWAY_API_KEY;
  delete process.env.JEV_AI_GATEWAY_API_KEY;
  try {
    assert.throws(() => createJevVerificationEvaluator({ fetch: async () => { assert.fail("fetch called"); } }), /JEV_AI_GATEWAY_API_KEY is required/);
    process.env.JEV_AI_GATEWAY_API_KEY = "synthetic-env-key";
    await createJevVerificationEvaluator({ fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-env-key");
      return Response.json({ answers });
    } })(request);
  } finally {
    if (previous === undefined) delete process.env.JEV_AI_GATEWAY_API_KEY;
    else process.env.JEV_AI_GATEWAY_API_KEY = previous;
  }
});

test("pinned gateway HTTP contract forwards state/questions/signal once; only answers and safe metrics escape", async () => {
  let calls = 0;
  const evaluate = createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.signal, request.signal);
    assert.deepEqual(init?.headers, {
      "Content-Type": "application/json", Authorization: "Bearer synthetic-key",
      "ai-gateway-protocol-version": "0.0.1", "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4", "ai-model-id": "typesafe-ai/jev",
    });
    assert.equal(init?.body, JSON.stringify({ state: request.state, questions: request.questions }));
    return Response.json({ answers, usage: { inputTokens: 5, outputTokens: -1, totalTokens: "unsafe" }, raw: "discarded", warnings: ["discarded"] });
  }, onMetrics: metrics => {
    assert.equal(metrics.inputTokens, 5);
    assert.equal(metrics.outputTokens, undefined);
    assert.equal(metrics.totalTokens, undefined);
    assert.equal(metrics.status, "completed");
  } });
  assert.equal(calls, 0);
  assert.deepEqual(await evaluate(request), { answers });
  assert.equal(calls, 1);
});

test("provider failures are sanitized, never retried, and error bodies are cancelled unread", async () => {
  let calls = 0, cancelled = false;
  const evaluate = createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  }, onMetrics: metrics => assert.equal(metrics.status, "provider_error") });
  await assert.rejects(evaluate(request), unavailable);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  await assert.rejects(createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => { throw new Error("raw error synthetic-key"); } })(request), unavailable);
});

test("aborted core signal prevents fetch and cancels a pending response stream", async () => {
  const evaluate = createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => { assert.fail("fetch called"); } });
  await assert.rejects(evaluate({ ...request, signal: AbortSignal.abort() }), unavailable);
  const controller = new AbortController();
  let cancelled = false;
  const pending = createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => new Response(new ReadableStream({
    pull() { controller.abort(); }, cancel() { cancelled = true; },
  })), onMetrics: metrics => assert.equal(metrics.status, "cancelled") });
  await assert.rejects(pending({ ...request, signal: controller.signal }), unavailable);
  assert.equal(cancelled, true);
});

test("response byte cap rejects declared and streamed oversize; malformed JSON is sanitized", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }),
    new Response("x".repeat(256 * 1024 + 1)),
    new Response("raw secret not JSON"),
  ]) {
    await assert.rejects(createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => response })(request), unavailable);
  }
});

test("compile batches questions in one HTTP request and core rejects malformed answers", async () => {
  let calls = 0;
  const dictionary = { id: "synthetic", version: "1", checks: [] };
  const compiledDictionary = { ...dictionary, checks: [{ id: "visible", description: "Synthetic item is visible", assertion: { kind: "see", target: "item" } satisfies import("../src/verification.ts").VerificationCheck["assertion"] }] };
  const evaluate = createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => {
    calls++;
    return Response.json({ answers: { ...answers, check_0: { type: "boolean", probability: 1 } } });
  } });
  const result = await compileVerification({ intent: "Verify synthetic item visible", dictionary: compiledDictionary, evaluate });
  assert.equal(result.status, "ready");
  assert.equal(result.modelCalls, 1);
  assert.equal(calls, 1);
  const invalid = await compileVerification({ intent: "Verify synthetic item visible", dictionary: compiledDictionary,
    evaluate: createJevVerificationEvaluator({ apiKey: "synthetic-key", fetch: async () => Response.json({ answers: { coverage: "unsafe" } }) }) });
  assert.equal(invalid.status, "incomplete");
});

test("benchmark mocked-live supported abstentions exit 2; wrong ready plans exit 1", () => {
  for (const probability of [0, 1]) {
    const setup = `globalThis.fetch = async (_url, init) => Response.json({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, { type: 'boolean', probability: ${probability} }])) });`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(setup)}`, fileURLToPath(new URL("../../../scripts/verification-benchmark.ts", import.meta.url)), "--live"], {
      env: { ...process.env, JEV_AI_GATEWAY_API_KEY: "synthetic-key" }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, probability === 0 ? 2 : 1);
    assert.equal(result.stdout.includes("synthetic-key"), false);
    assert.match(result.stdout, /"abstentionsArePasses": false/);
    if (probability === 0) assert.match(result.stdout, /"reason": "Verification selection is unsupported or uncertain"/);
  }
});
