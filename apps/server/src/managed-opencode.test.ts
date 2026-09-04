import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createManagedOpencodeServer } from "./managed-opencode.js";

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
      "setTimeout(() => console.error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), 50);",
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
