import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  appendEvent,
  EVENTS_ENV,
  eventsPath,
  progress,
  readEvents,
  tailEvents,
  type WorldEvent,
} from "../src/events.ts";

test("events append privately and read valid JSONL in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-events-"));
  try {
    const path = eventsPath(root, "demo");
    const events: WorldEvent[] = [
      { t: "one", type: "note", text: "first" },
      { t: "two", type: "ready", outputs: { url: "http://localhost" } },
    ];
    await appendEvent(path, events[0]);
    await writeFile(path, `${await readFile(path, "utf8")}invalid\n`, { mode: 0o600 });
    await appendEvent(path, events[1]);
    assert.deepEqual(await readEvents(path), events);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tailEvents emits newly completed lines in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-tail-"));
  try {
    const path = eventsPath(root, "demo");
    const seen: string[] = [];
    const tail = tailEvents(path, (event) => {
      if (event.type === "note") seen.push(event.text);
    }, { intervalMs: 5 });
    await appendEvent(path, { t: "one", type: "note", text: "first" });
    await appendEvent(path, { t: "two", type: "note", text: "second" });
    await delay(30);
    tail.stop();
    assert.deepEqual(seen, ["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress is inert without its env and emits step status with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-progress-"));
  const path = eventsPath(root, "demo");
  const previous = process.env[EVENTS_ENV];
  try {
    delete process.env[EVENTS_ENV];
    const inert = progress().step("noop", "No-op");
    await inert.ok();
    assert.deepEqual(await readEvents(path), []);

    process.env[EVENTS_ENV] = path;
    const active = progress().step("build", "Build", { log: "/tmp/build.log" });
    await active.ok("done");
    const failing = progress().step("serve", "Serve");
    await failing.fail("port busy");
    assert.deepEqual((await readEvents(path)).map((event) => (
      event.type === "step" ? [event.id, event.status, event.detail] : [event.type]
    )), [
      ["build", "start", undefined],
      ["build", "ok", "done"],
      ["serve", "start", undefined],
      ["serve", "fail", "port busy"],
    ]);
  } finally {
    if (previous === undefined) delete process.env[EVENTS_ENV];
    else process.env[EVENTS_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
