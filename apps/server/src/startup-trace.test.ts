import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const traceModuleFile = import.meta.url.endsWith(".js") ? "startup-trace.js" : "startup-trace.ts";
const moduleUrl = pathToFileURL(path.join(import.meta.dir, traceModuleFile));
const execFileAsync = promisify(execFile);

async function readEvents(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runTraceScript(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(process.execPath, ["--eval", script], {
    env,
    cwd: path.resolve(import.meta.dir, "../../.."),
  });
}

describe("startup trace", () => {
  test("disabled is a no-op", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-server-trace-disabled-"));
    const filePath = path.join(dir, "trace.ndjson");
    const previous = process.env.OPENWORK_STARTUP_TRACE;
    const env = { ...process.env };
    delete env.OPENWORK_STARTUP_TRACE;
    try {
      await runTraceScript(`
        import * as trace from ${JSON.stringify(moduleUrl.href)};
        if (trace.traceEnabled() !== false) process.exit(10);
        trace.traceMark("disabled.mark", { ok: true });
        const end = trace.traceSpan("disabled.span");
        end();
        trace.traceFlush();
      `, env);
      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.OPENWORK_STARTUP_TRACE;
      else process.env.OPENWORK_STARTUP_TRACE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("enabled writes valid mark and span NDJSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-server-trace-enabled-"));
    const filePath = path.join(dir, "trace.ndjson");
    const previous = process.env.OPENWORK_STARTUP_TRACE;
    const env = { ...process.env, OPENWORK_STARTUP_TRACE: filePath };
    try {
      await runTraceScript(`
        import * as trace from ${JSON.stringify(moduleUrl.href)};
        if (trace.traceEnabled() !== true) process.exit(11);
        trace.traceMark("test.mark", { value: 1 });
        const end = trace.traceSpan("test.span", { phase: "start" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        end({ phase: "end" });
        trace.traceFlush();
      `, env);

      const events = await readEvents(filePath);
      const processStart = events.find((event) => event.name === "process.start");
      const mark = events.find((event) => event.name === "test.mark");
      const span = events.find((event) => event.name === "test.span");
      const processStartMeta = isRecord(processStart) && isRecord(processStart.meta) ? processStart.meta : null;
      const spanMeta = isRecord(span) && isRecord(span.meta) ? span.meta : null;

      expect(processStart?.src).toBe("server");
      expect(processStart?.kind).toBe("mark");
      expect(typeof processStartMeta?.timeOrigin).toBe("number");
      expect(mark?.src).toBe("server");
      expect(mark?.kind).toBe("mark");
      expect(typeof mark?.pid).toBe("number");
      expect(typeof mark?.ts).toBe("number");
      expect(mark?.meta).toEqual({ value: 1 });
      expect(span?.src).toBe("server");
      expect(span?.kind).toBe("span");
      expect(typeof span?.pid).toBe("number");
      expect(typeof span?.ts).toBe("number");
      expect(spanMeta?.phase).toBe("end");
      expect(typeof span?.ms).toBe("number");
      expect(typeof span?.ms === "number" && span.ms >= 0 && span.ms < 5000).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENWORK_STARTUP_TRACE;
      else process.env.OPENWORK_STARTUP_TRACE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("traceWrap closes throwing spans and rethrows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-server-trace-wrap-"));
    const filePath = path.join(dir, "trace.ndjson");
    const previous = process.env.OPENWORK_STARTUP_TRACE;
    const env = { ...process.env, OPENWORK_STARTUP_TRACE: filePath };
    try {
      await runTraceScript(`
        import * as trace from ${JSON.stringify(moduleUrl.href)};
        const original = new Error("original failure");
        let thrown;
        try {
          await trace.traceWrap("test.throw", async () => {
            throw original;
          });
        } catch (error) {
          thrown = error;
        }
        if (thrown !== original) process.exit(12);
        trace.traceFlush();
      `, env);
      const events = await readEvents(filePath);
      const span = events.find((event) => event.name === "test.throw");
      expect(span?.kind).toBe("span");
      expect(typeof span?.ms).toBe("number");
    } finally {
      if (previous === undefined) delete process.env.OPENWORK_STARTUP_TRACE;
      else process.env.OPENWORK_STARTUP_TRACE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
