import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvent, progress, readEvents, worldTimingSteps } from "./events.ts";
import { main } from "./cli.ts";

const t0 = Date.parse("2026-01-01T00:00:00.000Z");

test("world reports original start through progress updates, success, failure and unfinished steps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "world-timing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.jsonl");
  const events = [
    { type: "step", id: "den-api", label: "Private label", status: "start", t: new Date(t0).toISOString() },
    { type: "step", id: "den-api", label: "Private label", detail: "Private progress", status: "start", t: new Date(t0 + 1000).toISOString() },
    { type: "step", id: "den-api", label: "Private label", status: "ok", t: new Date(t0 + 2500).toISOString() },
    { type: "step", id: "den-web", label: "Private label", status: "start", t: new Date(t0 + 1000).toISOString() },
    { type: "step", id: "den-web", label: "Private label", status: "fail", t: new Date(t0 + 3000).toISOString() },
    { type: "step", id: "den-auth", label: "Private label", status: "start", t: new Date(t0 + 3000).toISOString() },
  ];
  for (const event of events) await appendEvent(path, event);
  const before = await readFile(path, "utf8");
  assert.deepEqual(worldTimingSteps(await readEvents(path), t0 + 4000), [
    { step: "den-api", seconds: 2.5, outcome: "ok" },
    { step: "den-web", seconds: 2, outcome: "fail" },
    { step: "den-auth", seconds: 1, outcome: "fail" },
  ]);
  assert.equal(await readFile(path, "utf8"), before);
});

test("progress records feed timing without changing JSONL fields", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "world-timing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.OPENWORK_WORLD_EVENTS;
  t.after(() => { if (previous === undefined) delete process.env.OPENWORK_WORLD_EVENTS; else process.env.OPENWORK_WORLD_EVENTS = previous; });
  process.env.OPENWORK_WORLD_EVENTS = join(dir, "events.jsonl");
  const step = progress().step("den-api", "Private label", { log: "/private/log" });
  await step.progress("Private phase");
  await step.ok("Private result");
  const events = await readEvents(process.env.OPENWORK_WORLD_EVENTS);
  assert.equal(events.length, 3);
  assert.deepEqual(worldTimingSteps(events, Date.now()).map(({ seconds, ...entry }) => entry), [{ step: "den-api", outcome: "ok" }]);
});

test("world CLI reports success and failure from a launched recipe's JSONL", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "world-timing-launch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  for (const [name, value] of Object.entries({
    OPENWORK_PROCESS_TIMING_URL: "https://invalid.test/timing",
    OPENWORK_PROCESS_TIMING_KEY: "private-key",
    OPENWORK_WORLD_SNAPSHOT_DIR: join(dir, "snapshots"),
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(globalThis, "fetch", async (_, options) => { requests.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); });
  for (const outcome of ["ok", "fail"]) {
    await writeFile(join(dir, "timing-fixture.ts"), `
      import { progress } from ${JSON.stringify(new URL("./events.ts", import.meta.url).href)};
      const step = progress().step("den-api", "Private description");
      await new Promise(resolve => setTimeout(resolve, 15));
      await step.${outcome}("Private result");
      process.exitCode = ${outcome === "ok" ? 0 : 1};
    `);
    const code = await main(["up", "timing-fixture", "--plain"], { cwd: dir, worldsDirectory: dir, print: () => {}, progress: () => {} });
    assert.equal(code, outcome === "ok" ? 0 : 1);
    const events = await readEvents(join(dir, "snapshots", "timing-fixture.events.jsonl"));
    const payload = requests.at(-1);
    assert.equal(payload.process, "world");
    assert.equal(payload.outcome, outcome);
    assert.deepEqual(payload.steps, worldTimingSteps(events, Date.now()));
    assert.equal(JSON.stringify(payload).includes("Private"), false);
  }
  assert.equal(requests.length, 2);
});

test("world CLI reports a failed launch exactly once", async (t) => {
  const requests = [];
  for (const [name, value] of Object.entries({ OPENWORK_PROCESS_TIMING_URL: "https://invalid.test/timing", OPENWORK_PROCESS_TIMING_KEY: "private-key" })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(globalThis, "fetch", async (_, options) => { requests.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); });
  const code = await main(["up", "missing-world"], { cwd: process.cwd(), worldsDirectory: join(process.cwd(), "missing-directory"), print: () => {} });
  assert.equal(code, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].process, "world");
  assert.equal(requests[0].outcome, "fail");
  assert.equal(requests[0].steps[0].step, "launch");
});
