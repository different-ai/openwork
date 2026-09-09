import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createManagedOpencodeServer } from "./managed-opencode.js";
import { createManagedOpencodeV2Server } from "./managed-opencode-v2.js";
import { appendEngineOutputTail, createEngineStartupLineReader, ENGINE_OUTPUT_MAX_CHARS, ENGINE_STARTUP_LINE_MAX_CHARS } from "./engine-output.js";
import { loopbackFetch } from "./server-fetch.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-managed-opencode-"));
  roots.push(root);
  return root;
}

async function writeExecutable(root: string, name: string, lines: string[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, ["#!/usr/bin/env bun", ...lines].join("\n"));
  await chmod(path, 0o755);
  return path;
}

describe("managed OpenCode startup", () => {
  test("bounds diagnostic tails and partial lines, and stops parsing once ready", () => {
    let tail = "old diagnostics\n";
    for (let index = 0; index < 256; index++) {
      tail = appendEngineOutputTail(tail, "x".repeat(4096));
      expect(tail.length).toBeLessThanOrEqual(ENGINE_OUTPUT_MAX_CHARS);
    }
    tail = appendEngineOutputTail(tail, "y".repeat(ENGINE_OUTPUT_MAX_CHARS * 4) + "failure tail");
    expect(tail).toHaveLength(ENGINE_OUTPUT_MAX_CHARS);
    expect(tail.endsWith("failure tail")).toBe(true);
    expect(tail).not.toContain("old diagnostics");

    const seen: string[] = [];
    const lines = createEngineStartupLineReader((line) => { seen.push(line); lines.stop(); });
    lines.write("x".repeat(ENGINE_STARTUP_LINE_MAX_CHARS));
    lines.write("opencode server listening on http://wrong:1\n");
    expect(seen).toEqual([]);
    lines.write("open");
    lines.write("code server listening on http://127.0.0.1:12");
    expect(seen).toEqual([]);
    lines.write("345\r");
    expect(seen).toEqual([]);
    lines.write("\nopencode server listening on http://wrong:2\n");
    lines.write("opencode server listening without a URL\n".repeat(1000));
    expect(seen).toEqual(["opencode server listening on http://127.0.0.1:12345\r"]);
  });

  for (const engine of ["v1", "v2"]) {
    test(`${engine} recognizes fragmented stdout readiness amid stderr and keeps draining after ready`, async () => {
      const root = await createRoot();
      const bin = await writeExecutable(root, "noisy-startup.mjs", [
        "const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));",
        "const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[process.argv.indexOf('--port') + 1]), async fetch(request) {",
        "  if (new URL(request.url).pathname === '/noise') {",
        "    for (let i = 0; i < 32; i++) { await write(process.stdout, 'x'.repeat(65536)); await write(process.stderr, 'y'.repeat(65536)); }",
        "    await write(process.stdout, '\\nopencode server listening on http://127.0.0.1:1\\nopencode server listening without a URL\\n');",
        "  }",
        "  return Response.json({ healthy: true, version: 'test', pid: process.pid });",
        "} });",
        "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
        "await write(process.stdout, 'old stdout\\n' + 'x'.repeat(1048576) + '\\nopen');",
        "await write(process.stderr, 'old stderr\\n' + 'y'.repeat(1048576) + '\\nserver listening on http://127.0.0.1:1\\n');",
        "await write(process.stdout, 'code server listening on http://127.0.0.1:');",
        "await write(process.stderr, 'interleaved diagnostic\\n');",
        "await write(process.stdout, `${server.port}\\r\\n`);",
      ]);
      const managed = engine === "v1"
        ? await createManagedOpencodeServer({ bin, cwd: root, timeoutMs: 5000 })
        : await createManagedOpencodeV2Server({ bin, rootDir: root, bootTimeoutMs: 5000 });
      try {
        const url = managed.url;
        const response = await loopbackFetch(`${url}/noise`, { signal: AbortSignal.timeout(5000) });
        expect(await response.json()).toEqual({ healthy: true, version: "test", pid: "pid" in managed ? managed.pid : managed.childPid });
        expect(managed.url).toBe(url);
        expect((await loopbackFetch(url, { signal: AbortSignal.timeout(5000) })).ok).toBe(true);
        if ("stdout" in managed) {
          expect(managed.stdout.length).toBeLessThanOrEqual(ENGINE_OUTPUT_MAX_CHARS);
          expect(managed.stderr.length).toBeLessThanOrEqual(ENGINE_OUTPUT_MAX_CHARS);
          expect(managed.stdout).not.toContain("old stdout");
          expect(managed.stderr).not.toContain("old stderr");
        }
      } finally {
        await managed.close();
      }
    });

    test(`${engine} retains bounded final diagnostics when startup fails after large output`, async () => {
      const root = await createRoot();
      const bin = await writeExecutable(root, "noisy-failure.mjs", [
        "const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));",
        "await write(process.stdout, 'old stdout\\n' + 'x'.repeat(1048576) + '\\nfinal stdout diagnostic\\n');",
        "await write(process.stderr, 'old stderr\\n' + 'y'.repeat(1048576) + '\\nfatal configuration tail\\n');",
        "process.exit(1);",
      ]);
      let thrown: unknown;
      try {
        if (engine === "v1") await createManagedOpencodeServer({ bin, cwd: root });
        else await createManagedOpencodeV2Server({ bin, rootDir: root });
      } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      if (!(thrown instanceof Error)) throw new Error("Expected noisy startup to fail");
      expect(thrown.message).toContain("exited with code 1");
      expect(thrown.message).toContain("final stdout diagnostic");
      expect(thrown.message).toContain("fatal configuration tail");
      expect(thrown.message).not.toContain("old stdout");
      expect(thrown.message).not.toContain("old stderr");
      expect(thrown.message.length).toBeLessThan(ENGINE_OUTPUT_MAX_CHARS * 2 + 200);
    });
  }

  test("gives the next engine a policy-only credential without inheriting the client credential", async () => {
    const root = await createRoot();
    const bin = await writeExecutable(root, "policy-env.mjs", [
      "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {",
      "  if (new URL(request.url).pathname === '/env') return Response.json({ policy: process.env.OPENWORK_POLICY_TOKEN, client: process.env.OPENWORK_SERVER_TOKEN ?? null });",
      "  return Response.json({ healthy: true, version: 'test', pid: process.pid });",
      "} });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeV2Server({
      bin, rootDir: root,
      env: { OPENWORK_SERVER_TOKEN: "must-stay-private", OPENWORK_POLICY_TOKEN: "policy-only-test-token" },
    });
    try {
      expect(await managed.fetchJson("/env")).toEqual({ status: 200, json: { policy: "policy-only-test-token", client: null } });
    } finally { await managed.close(); }
  });

  test("spawns the engine with npm audit disabled so first-run installs never wait on the advisories endpoint", async () => {
    const root = await createRoot();
    const defaultDumpPath = join(root, "default-env.log");
    const overrideDumpPath = join(root, "override-env.log");
    const bin = await writeExecutable(root, "dump-npm-audit-env.mjs", [
      "import { writeFileSync } from 'node:fs';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "writeFileSync(process.env.ENV_DUMP_PATH, process.env.npm_config_audit ?? '<unset>');",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);

    const managedDefault = await createManagedOpencodeServer({ bin, cwd: root, env: { ENV_DUMP_PATH: defaultDumpPath } });
    expect(await readFile(defaultDumpPath, "utf8")).toBe("false");
    await managedDefault.close();

    const managedOverride = await createManagedOpencodeServer({
      bin,
      cwd: root,
      env: { ENV_DUMP_PATH: overrideDumpPath, npm_config_audit: "true" },
    });
    expect(await readFile(overrideDumpPath, "utf8")).toBe("true");
    await managedOverride.close();
  });

  test("waits for inherited diagnostic streams before retrying a code-1 EADDRINUSE exit", async () => {
    const root = await createRoot();
    const attemptsPath = join(root, "attempts.log");
    const markerPath = join(root, "first-attempt");
    const diagnosticPath = join(root, "delayed-eaddrinuse.mjs");
    await writeFile(diagnosticPath, [
      "const port = process.argv[2];",
      "setTimeout(async () => {",
      "  const write = (text) => new Promise((resolve) => process.stderr.write(text, resolve));",
      "  await write('listen EADDR');",
      "  await write(`INUSE: address already in use 127.0.0.1:${port}\\n`);",
      "  await write('x'.repeat(1048576) + '\\nfinal retry diagnostic\\n');",
      "}, 50);",
    ].join("\n"));
    const bin = await writeExecutable(root, "retry-eaddrinuse.mjs", [
      "import { spawn } from 'node:child_process';",
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "appendFileSync(process.env.ATTEMPTS_PATH, `start:${port}\\n`);",
      "if (!existsSync(process.env.MARKER_PATH)) {",
      "  writeFileSync(process.env.MARKER_PATH, 'claimed');",
      "  spawn(process.execPath, [process.env.DIAGNOSTIC_PATH, String(port)], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
      "  process.exit(1);",
      "}",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { appendFileSync(process.env.ATTEMPTS_PATH, 'SIGTERM\\n'); server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeServer({
      bin,
      cwd: root,
      env: { ATTEMPTS_PATH: attemptsPath, DIAGNOSTIC_PATH: diagnosticPath, MARKER_PATH: markerPath },
    });

    await managed.close();

    const lines = (await readFile(attemptsPath, "utf8")).trim().split("\n");
    const ports = lines.filter((line) => line.startsWith("start:")).map((line) => line.slice("start:".length));
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);
    expect(lines.filter((line) => line === "SIGTERM")).toHaveLength(1);
  });

  test("keeps an unknown code-1 exit actionable and does not retry it", async () => {
    const root = await createRoot();
    const attemptsPath = join(root, "attempts.log");
    const bin = await writeExecutable(root, "unknown-code-one.mjs", [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.ATTEMPTS_PATH, 'start\\n');",
      "console.log('startup diagnostics from stdout');",
      "console.error('fatal provider configuration mismatch');",
      "process.exit(1);",
    ]);
    let thrown: unknown;

    try {
      await createManagedOpencodeServer({ bin, cwd: root, env: { ATTEMPTS_PATH: attemptsPath } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("Expected managed OpenCode startup to fail");
    expect(thrown.message).toContain("OpenCode server exited with code 1");
    expect(thrown.message).toContain("startup diagnostics from stdout");
    expect(thrown.message).toContain("fatal provider configuration mismatch");
    expect((await readFile(attemptsPath, "utf8")).trim().split("\n")).toEqual(["start"]);
  });
});
