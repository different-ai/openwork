import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "startup-trace.mjs"));

function uniqueModuleUrl(name) {
  const url = new URL(moduleUrl.href);
  url.searchParams.set("case", `${name}-${Date.now()}-${Math.random()}`);
  return url.href;
}

async function readEvents(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

test("startup trace disabled is a no-op", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-trace-disabled-"));
  const filePath = path.join(dir, "trace.ndjson");
  const previous = process.env.OPENWORK_STARTUP_TRACE;
  delete process.env.OPENWORK_STARTUP_TRACE;
  try {
    const trace = await import(uniqueModuleUrl("disabled"));
    assert.equal(trace.traceEnabled(), false);
    assert.doesNotThrow(() => {
      trace.traceMark("disabled.mark", { ok: true });
      const end = trace.traceSpan("disabled.span");
      end();
      trace.traceFlush();
    });
    await assert.rejects(stat(filePath));
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_STARTUP_TRACE;
    else process.env.OPENWORK_STARTUP_TRACE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup trace writes valid mark and span NDJSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-trace-enabled-"));
  const filePath = path.join(dir, "trace.ndjson");
  const previous = process.env.OPENWORK_STARTUP_TRACE;
  process.env.OPENWORK_STARTUP_TRACE = filePath;
  try {
    const trace = await import(uniqueModuleUrl("enabled"));
    assert.equal(trace.traceEnabled(), true);
    trace.traceMark("test.mark", { value: 1 });
    const end = trace.traceSpan("test.span", { phase: "start" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    end({ phase: "end" });
    trace.traceFlush();

    const events = await readEvents(filePath);
    const processStart = events.find((event) => event.name === "process.start");
    const mark = events.find((event) => event.name === "test.mark");
    const span = events.find((event) => event.name === "test.span");

    assert.equal(processStart?.src, "main");
    assert.equal(processStart?.kind, "mark");
    assert.equal(typeof processStart?.meta?.timeOrigin, "number");
    assert.equal(mark?.src, "main");
    assert.equal(mark?.kind, "mark");
    assert.equal(mark?.pid, process.pid);
    assert.equal(typeof mark?.ts, "number");
    assert.deepEqual(mark?.meta, { value: 1 });
    assert.equal(span?.src, "main");
    assert.equal(span?.kind, "span");
    assert.equal(span?.pid, process.pid);
    assert.equal(typeof span?.ts, "number");
    assert.equal(span?.meta?.phase, "end");
    assert.equal(typeof span?.ms, "number");
    assert.ok(span.ms >= 0 && span.ms < 5000);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_STARTUP_TRACE;
    else process.env.OPENWORK_STARTUP_TRACE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup trace closes throwing traceWrap spans and rethrows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-trace-wrap-"));
  const filePath = path.join(dir, "trace.ndjson");
  const previous = process.env.OPENWORK_STARTUP_TRACE;
  process.env.OPENWORK_STARTUP_TRACE = filePath;
  try {
    const trace = await import(uniqueModuleUrl("throwing-wrap"));
    const original = new Error("original failure");
    let thrown;
    try {
      await trace.traceWrap("test.throw", async () => {
        throw original;
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, original);
    trace.traceFlush();
    const events = await readEvents(filePath);
    const span = events.find((event) => event.name === "test.throw");
    assert.equal(span?.kind, "span");
    assert.equal(typeof span?.ms, "number");
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_STARTUP_TRACE;
    else process.env.OPENWORK_STARTUP_TRACE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
