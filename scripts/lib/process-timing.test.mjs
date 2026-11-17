import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { reportProcessTiming } from "./process-timing.mjs";

const key = "private-test-bearer-key";
const sha = "a".repeat(40);
const run = { process: "check", startedAt: "2026-01-01T00:00:00.000Z", totalSeconds: 1.23456, outcome: "ok", steps: [{ step: "typecheck", seconds: 1.23456, outcome: "ok" }] };

function configure(t, values = {}) {
  for (const [name, value] of Object.entries({
    OPENWORK_PROCESS_TIMING_URL: "http://127.0.0.1:1/timing",
    OPENWORK_PROCESS_TIMING_KEY: key,
    OPENWORK_PROCESS_TIMING_DEBUG: undefined,
    OPENWORK_PROCESS_TIMING_HEAD_SHA: sha,
    CI: undefined,
    ...values,
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}

function capture(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options, payload: JSON.parse(options.body) });
    return new Response(null, { status: 204 });
  });
  return requests;
}

test("off unless both nonempty settings exist, without fetch or output", async (t) => {
  const requests = capture(t);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  for (const values of [
    { OPENWORK_PROCESS_TIMING_URL: undefined, OPENWORK_PROCESS_TIMING_KEY: undefined },
    { OPENWORK_PROCESS_TIMING_URL: "" },
    { OPENWORK_PROCESS_TIMING_KEY: "" },
  ]) {
    configure(t, values);
    await reportProcessTiming(run);
  }
  assert.equal(requests.length, 0);
  assert.equal(stderr.mock.callCount(), 0);
});

test("sends exactly the wire contract, never caller extras", async (t) => {
  configure(t, { CI: "1", OPENWORK_PROCESS_TIMING_HEAD_SHA: "b".repeat(40), GITHUB_SHA: sha });
  const requests = capture(t);
  await reportProcessTiming({ ...run, output: key, branch: "secret", steps: [{ ...run.steps[0], error: key }] });
  const request = requests[0];
  assert.equal(request.url, "http://127.0.0.1:1/timing");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, `Bearer ${key}`);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.redirect, "error");
  assert.match(request.payload.runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(request.payload, {
    version: 1, runId: request.payload.runId, process: "check", environment: "ci", commit: "b".repeat(40),
    startedAt: run.startedAt, totalSeconds: 1.235, outcome: "ok",
    steps: [{ step: "typecheck", seconds: 1.235, outcome: "ok" }],
  });
  assert.ok(!request.body.includes(key));
});

test("sanitizes, truncates and drops empty names, clamps and rounds seconds", async (t) => {
  configure(t);
  const requests = capture(t);
  await reportProcessTiming({ ...run, totalSeconds: Infinity, steps: [
    { step: " A/B C:_Done", seconds: -1, outcome: "fail" },
    { step: "!!!", seconds: 1, outcome: "ok" },
    { step: "", seconds: 1, outcome: "ok" },
    { step: "X".repeat(70), seconds: Infinity, outcome: "skipped" },
    { step: "nan", seconds: NaN, outcome: "ok" },
    { step: "fraction", seconds: 1.23456, outcome: "ok" },
  ] });
  assert.equal(requests[0].payload.environment, "local");
  assert.equal(requests[0].payload.totalSeconds, 86400);
  assert.deepEqual(requests[0].payload.steps, [
    { step: "a-b-c:_done", seconds: 0, outcome: "fail" },
    { step: "x".repeat(64), seconds: 86400, outcome: "skipped" },
    { step: "nan", seconds: 0, outcome: "ok" },
    { step: "fraction", seconds: 1.235, outcome: "ok" },
  ]);
  await reportProcessTiming({ ...run, steps: [{ step: "???", seconds: 0, outcome: "ok" }] });
  assert.equal(requests.length, 1);
});

test("commit falls back to GitHub SHA, then null when git is unavailable", async (t) => {
  configure(t, { OPENWORK_PROCESS_TIMING_HEAD_SHA: "not-a-sha", GITHUB_SHA: sha, PATH: "" });
  const requests = capture(t);
  await reportProcessTiming(run);
  assert.equal(requests[0].payload.commit, sha);
  process.env.GITHUB_SHA = "not-a-sha";
  await reportProcessTiming(run);
  assert.equal(requests[1].payload.commit, null);
});

test("keeps the slowest 200 steps", async (t) => {
  configure(t);
  const requests = capture(t);
  await reportProcessTiming({ ...run, steps: Array.from({ length: 250 }, (_, index) => ({ step: `step-${index}`, seconds: index, outcome: "ok" })) });
  assert.equal(requests[0].payload.steps.length, 200);
  assert.equal(requests[0].payload.steps[0].seconds, 249);
  assert.equal(requests[0].payload.steps[199].seconds, 50);
});

test("network, HTTP and invalid-input failures are swallowed with no secret output", async (t) => {
  configure(t);
  const output = [];
  t.mock.method(process.stderr, "write", (text) => { output.push(text); return true; });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error(key); });
  await assert.doesNotReject(reportProcessTiming(run));
  assert.deepEqual(output, []);
  process.env.OPENWORK_PROCESS_TIMING_DEBUG = "1";
  await assert.doesNotReject(reportProcessTiming(run));
  fetch.mock.mockImplementation(async () => new Response(key, { status: 503 }));
  await assert.doesNotReject(reportProcessTiming(run));
  await assert.doesNotReject(reportProcessTiming({ ...run, startedAt: "bad" }));
  assert.equal(output.length, 3);
  assert.ok(output.every((line) => line === "Process timing report failed.\n"));
  assert.ok(!output.join("").includes(key));
});

test("a stalled endpoint times out in three seconds, without retrying", async (t) => {
  let requests = 0;
  const server = createServer(() => { requests += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  configure(t, { OPENWORK_PROCESS_TIMING_URL: `http://127.0.0.1:${server.address().port}` });
  const started = performance.now();
  await assert.doesNotReject(reportProcessTiming(run));
  assert.ok(performance.now() - started < 3500);
  assert.equal(requests, 1);
});
