import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservabilityEventInput } from "@openwork/observability";
import { createManagedOpencodeServer, parseStructuredOpencodeLog } from "./managed-opencode.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("managed OpenCode observability", () => {
  test("parses pinned OpenCode structured log fields", () => {
    expect(parseStructuredOpencodeLog(
      'timestamp=2026-07-22T12:00:00.000Z level=WARN run=abc message="server unavailable" key=docs type=remote status=failed',
    )).toMatchObject({
      level: "WARN",
      message: "server unavailable",
      key: "docs",
      status: "failed",
    });
  });

  test("line-buffers process output and emits lifecycle events without putting text in metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-opencode-observability-"));
    roots.push(root);
    const executable = join(root, "fake-opencode.sh");
    await writeFile(executable, `#!/bin/sh
printf 'opencode server '
printf 'listening on http://127.0.0.1:45678\\n'
printf 'fake warning\\n' >&2
printf '%s\\n' "$OPENWORK_SERVER_TOKEN" >&2
printf '%s\\n' "$OPENAI_API_KEY" >&2
printf 'timestamp=2026-07-22T12:00:00.000Z level=WARN run=abc message="server unavailable" key=docs type=remote status=failed\\n' >&2
printf 'tail without newline'
exec sleep 5
`, "utf8");
    await chmod(executable, 0o755);

    const events: ObservabilityEventInput[] = [];
    const previousInheritedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "v9Q";
    const managed = await createManagedOpencodeServer({
      bin: executable,
      cwd: root,
      timeoutMs: 2_000,
      env: { OPENWORK_SERVER_TOKEN: "q7Z" },
      observe: (event) => {
        events.push(event);
      },
    });
    await managed.close();
    if (previousInheritedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousInheritedKey;

    expect(managed.url).toBe("http://127.0.0.1:45678");
    expect(managed.execution.args).toContain("--print-logs");
    expect(managed.instanceId).toBeTruthy();
    expect(managed.execution.env).toContainEqual(expect.objectContaining({
      name: "OPENWORK_OPENCODE_INSTANCE_ID",
      value: managed.instanceId,
    }));
    expect(events.map((event) => event.action)).toContain("opencode.process.spawned");
    expect(events.map((event) => event.action)).toContain("opencode.process.listening");
    expect(events.map((event) => event.action)).toContain("opencode.process.exited");
    expect(events.map((event) => event.action)).toContain("opencode.process.close.completed");

    const stdout = events.find((event) => (
      event.action === "opencode.process.stdout"
      && event.content?.value === "opencode server listening on http://127.0.0.1:45678"
    ));
    const stderr = events.find((event) => event.action === "opencode.process.stderr");
    expect(stdout?.data).toMatchObject({ stream: "stdout" });
    expect(stdout?.content).toMatchObject({
      kind: "text",
      length: "opencode server listening on http://127.0.0.1:45678".length,
    });
    expect(stderr?.content?.value).toBe("fake warning");
    expect(JSON.stringify(events)).not.toContain("q7Z");
    expect(JSON.stringify(events)).not.toContain("v9Q");
    expect(JSON.stringify(events)).toContain("[REDACTED]");
    expect(events).toContainEqual(expect.objectContaining({
      level: "error",
      scope: "mcp",
      action: "mcp.connection.failed",
      data: expect.objectContaining({ server: "docs", status: "failed" }),
    }));
  });

  test("redacts a secret that straddles the bounded line-buffer split", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-opencode-observability-"));
    roots.push(root);
    const executable = join(root, "fake-opencode.ts");
    const leftCanary = "BOUNDARY_CANARY_LEFT";
    const rightCanary = "BOUNDARY_CANARY_RIGHT";
    const boundarySecret = `${leftCanary}${rightCanary}`;
    const prefixLength = (64 * 1024) - leftCanary.length;
    await writeFile(executable, `#!/usr/bin/env bun
process.stdout.write("x".repeat(${prefixLength}));
process.stdout.write(process.env.CROSS_BOUNDARY_TOKEN ?? "");
process.stdout.write(" suffix\\n");
process.stdout.write("opencode server listening on http://127.0.0.1:45679\\n");
setTimeout(() => {}, 5_000);
`, "utf8");
    await chmod(executable, 0o755);

    const events: ObservabilityEventInput[] = [];
    const managed = await createManagedOpencodeServer({
      bin: executable,
      cwd: root,
      timeoutMs: 2_000,
      env: { CROSS_BOUNDARY_TOKEN: boundarySecret },
      observe: (event) => {
        events.push(event);
      },
    });
    await managed.close();

    const serialized = JSON.stringify(events);
    expect(managed.url).toBe("http://127.0.0.1:45679");
    expect(serialized).not.toContain(boundarySecret);
    expect(serialized).not.toContain(leftCanary);
    expect(serialized).not.toContain(rightCanary);
    const longLineEvents = events.filter((event) => (
      event.action === "opencode.process.stdout"
      && event.content?.length !== "opencode server listening on http://127.0.0.1:45679".length
    ));
    expect(longLineEvents).toHaveLength(1);
  });

  test("drains immediate-exit output before finalizing split-secret redaction and the final tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-opencode-observability-"));
    roots.push(root);
    const executable = join(root, "fake-opencode.sh");
    const leftCanary = "drain-left-7Q";
    const rightCanary = "drain-right-9Z";
    const splitSecret = `${leftCanary}${rightCanary}`;
    await writeFile(executable, `#!/bin/sh
printf 'opencode server listening on http://127.0.0.1:45680\\n'
printf 'prefix ${leftCanary}' >&2
sleep 0.05
(sleep 0.05; printf '${rightCanary} final-tail' >&2) &
exit 0
`, "utf8");
    await chmod(executable, 0o755);

    const events: ObservabilityEventInput[] = [];
    const managed = await createManagedOpencodeServer({
      bin: executable,
      cwd: root,
      timeoutMs: 2_000,
      env: { IMMEDIATE_EXIT_TOKEN: splitSecret },
      observe: (event) => {
        events.push(event);
      },
    });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (events.some((event) => event.action === "opencode.process.exited")) break;
      await Bun.sleep(10);
    }

    const stderrIndex = events.findIndex((event) => (
      event.action === "opencode.process.stderr"
      && typeof event.content?.value === "string"
      && event.content.value.includes("final-tail")
    ));
    const exitIndex = events.findIndex((event) => event.action === "opencode.process.exited");
    const serialized = JSON.stringify(events);
    expect(stderrIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(stderrIndex);
    expect(events[stderrIndex]?.content?.value).toBe("prefix [REDACTED] final-tail");
    expect(events[exitIndex]?.data).toMatchObject({ code: 0, expected: false });
    expect(serialized).not.toContain(splitSecret);
    expect(serialized).not.toContain(leftCanary);
    expect(serialized).not.toContain(rightCanary);

    await managed.close();
  });
});
