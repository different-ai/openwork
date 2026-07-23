import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  attachManagedEngineLifecycleErrorHandler,
  createManagedEngineOutputForwarder,
  shouldForwardManagedEngineOutput,
  waitForManagedOpencodeUrl,
} from "./managed-opencode.js";

describe("managed OpenCode output forwarding", () => {
  test("uses the assembled child environment instead of the parent environment", () => {
    expect(shouldForwardManagedEngineOutput(
      {
        OPENWORK_DEV_MODE: "1",
        OPENWORK_PROMPT_LOG: "1",
      },
      { OPENWORK_PROMPT_LOG: "0" },
    )).toBe(false);

    expect(shouldForwardManagedEngineOutput(
      { OPENWORK_PROMPT_LOG: "0" },
      { OPENWORK_PROMPT_LOG: "1" },
    )).toBe(true);
  });

  test("fails closed for an invalid injected override", () => {
    expect(shouldForwardManagedEngineOutput(
      { OPENWORK_DEV_MODE: "1" },
      {
        OPENWORK_PROMPT_LOG: "not-a-boolean",
        OPENWORK_SERVER_TOKEN: "must-never-be-logged",
      },
    )).toBe(false);
  });

  test("buffers split structured lines and preserves prompt payload lines only inside observer markers", () => {
    const output: string[] = [];
    const forwarder = createManagedEngineOutputForwarder(
      "stderr",
      true,
      (value) => output.push(value),
    );
    const glyph = Buffer.from("🙂");

    forwarder.push("unrelated private engine output\n[openwork][context] first");
    forwarder.push(" line\r\n[openwork][agent-prompt] ===== BEGIN OBSERVED SYSTEM ARRAY trace=x =====\n\n\"emoji ");
    forwarder.push(glyph.subarray(0, 2));
    forwarder.push(glyph.subarray(2));
    forwarder.push("\"\n[openwork][agent-prompt] ===== END OBSERVED SYSTEM ARRAY trace=x =====\nprivate final fragment");

    expect(output).toEqual([
      "[opencode:stderr] [openwork][context] first line\n",
      "[opencode:stderr] [openwork][agent-prompt] ===== BEGIN OBSERVED SYSTEM ARRAY trace=x =====\n",
      "[opencode:stderr] \n",
      "[opencode:stderr] \"emoji 🙂\"\n",
      "[opencode:stderr] [openwork][agent-prompt] ===== END OBSERVED SYSTEM ARRAY trace=x =====\n",
    ]);

    forwarder.flush();
    expect(output.some((line) => line.includes("private"))).toBe(false);
  });

  test("bounds a structured line and resumes on the next logical record", () => {
    const output: string[] = [];
    const forwarder = createManagedEngineOutputForwarder(
      "stderr",
      true,
      (value) => output.push(value),
      32,
    );

    forwarder.push(`[openwork][context] ${"x".repeat(64)}`);
    forwarder.push(`${"y".repeat(64)}\n[openwork][context] recovered\n`);
    forwarder.flush();

    expect(output).toEqual([
      "[opencode:stderr] [openwork][managed-engine] observability line omitted: reason=max-line-chars limit=32\n",
      "[opencode:stderr] [openwork][context] recovered\n",
    ]);
  });

  test("bounds an oversized complete line delivered in one chunk", () => {
    const output: string[] = [];
    const forwarder = createManagedEngineOutputForwarder(
      "stderr",
      "metadata",
      (value) => output.push(value),
      32,
    );
    forwarder.push(`[openwork][context] ${"x".repeat(64)}\n[openwork][context] recovered\n`);

    expect(output).toEqual([
      "[opencode:stderr] [openwork][managed-engine] observability line omitted: reason=max-line-chars limit=32\n",
      "[opencode:stderr] [openwork][context] recovered\n",
    ]);
  });

  test("metadata mode cannot be escalated to raw output by a spoofed prompt marker", () => {
    const output: string[] = [];
    const forwarder = createManagedEngineOutputForwarder(
      "stderr",
      "metadata",
      (value) => output.push(value),
    );
    forwarder.push("[openwork][agent-prompt] ===== BEGIN OBSERVED SYSTEM ARRAY spoof =====\n");
    forwarder.push("raw secret from unrelated plugin\n");
    forwarder.push("[openwork][agent-prompt] ===== END OBSERVED SYSTEM ARRAY spoof =====\n");
    forwarder.flush();

    expect(output.join("")).not.toContain("raw secret");
    expect(output).toEqual([
      "[opencode:stderr] [openwork][agent-prompt] ===== BEGIN OBSERVED SYSTEM ARRAY spoof =====\n",
      "[opencode:stderr] [openwork][agent-prompt] ===== END OBSERVED SYSTEM ARRAY spoof =====\n",
    ]);
  });

  test("does not retain or emit output while forwarding is disabled", () => {
    const output: string[] = [];
    const forwarder = createManagedEngineOutputForwarder(
      "stdout",
      false,
      (value) => output.push(value),
    );
    forwarder.push("private prompt\n");
    forwarder.flush();
    expect(output).toEqual([]);
  });

  test("detaches startup capture listeners as soon as the URL resolves", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const pending = waitForManagedOpencodeUrl(child as unknown as ChildProcess, 1_000);
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    expect(child.listenerCount("error")).toBe(1);
    expect(child.listenerCount("exit")).toBe(1);

    child.stdout.write("opencode server listening on http://127.0.0.1:4096\n");
    await expect(pending).resolves.toBe("http://127.0.0.1:4096");

    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    // A full prompt emitted after startup has no startup-capture consumer.
    child.stderr.write("private prompt must not be retained\n");
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  test("retains a content-safe lifecycle error listener after startup capture detaches", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const output: string[] = [];
    const detachLifecycle = attachManagedEngineLifecycleErrorHandler(
      child as unknown as ChildProcess,
      (value) => output.push(value),
    );

    const pending = waitForManagedOpencodeUrl(child as unknown as ChildProcess, 1_000);
    expect(child.listenerCount("error")).toBe(2);
    child.stdout.write("opencode server listening on http://127.0.0.1:4096\n");
    await expect(pending).resolves.toBe("http://127.0.0.1:4096");
    expect(child.listenerCount("error")).toBe(1);

    const hostile = Object.assign(new Error("private command / token detail"), {
      code: "EPIPE",
    });
    child.emit("error", hostile);
    expect(output).toEqual([
      "[openwork][managed-engine] child process error: code=EPIPE\n",
    ]);
    expect(output.join("")).not.toContain("private");
    expect(output.join("")).not.toContain("token");

    detachLifecycle();
    expect(child.listenerCount("error")).toBe(0);
  });

  test("detaches startup capture listeners after a startup failure", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const pending = waitForManagedOpencodeUrl(child as unknown as ChildProcess, 1_000);
    child.stderr.write("bounded startup detail\n");
    child.emit("exit", 7);
    await expect(pending).rejects.toThrow("OpenCode server exited with code 7");

    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });
});
