import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

type TraceMeta = Record<string, unknown>;
type TraceEnd = (endMeta?: TraceMeta) => void;
type TraceEnabled = () => boolean;
type TraceMark = (name: string, meta?: TraceMeta) => void;
type TraceSpan = (name: string, meta?: TraceMeta) => TraceEnd;
type TraceWrap = <T>(name: string, fn: () => Promise<T>, meta?: TraceMeta) => Promise<T>;
type TraceFlush = () => void;
type TraceEvent =
  | {
      ts: number;
      pid: number;
      src: "server";
      name: string;
      kind: "mark";
      meta: TraceMeta;
    }
  | {
      ts: number;
      pid: number;
      src: "server";
      name: string;
      kind: "span";
      ms: number;
      meta: TraceMeta;
    };

const traceEnv = process.env.OPENWORK_STARTUP_TRACE ?? "";
const enabled = traceEnv.length > 0;
const outputPath = traceEnv === "1"
  ? path.join(os.tmpdir(), "openwork-startup-trace.ndjson")
  : traceEnv;

const noopEnd: TraceEnd = () => undefined;
const disabledTraceEnabled: TraceEnabled = () => false;
const disabledTraceMark: TraceMark = () => undefined;
const disabledTraceSpan: TraceSpan = () => noopEnd;
const disabledTraceWrap: TraceWrap = async (_name, fn) => fn();
const disabledTraceFlush: TraceFlush = () => undefined;

export let traceEnabled: TraceEnabled = disabledTraceEnabled;
export let traceMark: TraceMark = disabledTraceMark;
export let traceSpan: TraceSpan = disabledTraceSpan;
export let traceWrap: TraceWrap = disabledTraceWrap;
export let traceFlush: TraceFlush = disabledTraceFlush;

if (enabled) {
  const buffer: TraceEvent[] = [];
  let scheduled = false;

  const now = () => performance.timeOrigin + performance.now();

  const syncFlush = () => {
    if (buffer.length === 0 || !outputPath) return;
    const events = buffer.splice(0, buffer.length);
    try {
      const lines = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      mkdirSync(path.dirname(outputPath), { recursive: true });
      appendFileSync(outputPath, lines, "utf8");
    } catch {
      // Startup tracing must never affect boot.
    }
  };

  const scheduleFlush = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      syncFlush();
    });
  };

  const record = (event: TraceEvent) => {
    try {
      buffer.push(event);
      if (buffer.length > 64) {
        syncFlush();
      } else {
        scheduleFlush();
      }
    } catch {
      // Startup tracing must never affect boot.
    }
  };

  traceEnabled = () => true;
  traceFlush = syncFlush;
  traceMark = (name, meta = {}) => {
    record({
      ts: now(),
      pid: process.pid,
      src: "server",
      name,
      kind: "mark",
      meta,
    });
  };
  traceSpan = (name, meta = {}) => {
    const startedAt = performance.now();
    let closed = false;
    return (endMeta = {}) => {
      if (closed) return;
      closed = true;
      const endedAt = performance.now();
      record({
        ts: performance.timeOrigin + endedAt,
        pid: process.pid,
        src: "server",
        name,
        kind: "span",
        ms: endedAt - startedAt,
        meta: { ...meta, ...endMeta },
      });
    };
  };
  traceWrap = async (name, fn, meta = {}) => {
    const end = traceSpan(name, meta);
    try {
      return await fn();
    } finally {
      end();
    }
  };

  process.on("exit", () => syncFlush());
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = () => {
      syncFlush();
      if (process.listenerCount(signal) === 1) {
        try {
          process.removeListener(signal, handler);
          process.kill(process.pid, signal);
        } catch {
          // Startup tracing must never affect boot.
        }
      }
    };
    process.on(signal, handler);
  }

  traceMark("process.start", { timeOrigin: performance.timeOrigin, argv0: process.argv0 });
}
