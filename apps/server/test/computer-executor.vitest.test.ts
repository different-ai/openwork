import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, vi } from "vitest";
import { createFakeProvider } from "@openwork/sandbox/testing";
import { SandboxError, type RunSpec } from "@openwork/sandbox";
import { runOnComputer } from "../src/computers/executor.js";
import { computerActionForTool, translateComputerInput } from "../src/computers/input.js";
import { SANDBOX_TOOL_NAMES, SandboxToolError } from "../src/sandbox-tool-host.js";
import nativeSchemas from "./fixtures/opencode-2.2.6-computer-tools.json";

const cases = {
  shell: [{ command: "pwd", workdir: "project", timeout: 35, background: false }, { type: "shell", command: "pwd", cwd: "/workspace/project", timeoutMs: 35 }],
  read: [{ path: "project/a", offset: 2, limit: 10 }, { type: "read", path: "/workspace/project/a" }],
  write: [{ path: "project/a", content: "new" }, { type: "write", path: "/workspace/project/a" }],
  edit: [{ path: "project/a", oldString: "old", newString: "new", replaceAll: true }, { type: "write", path: "/workspace/project/a" }],
  glob: [{ path: "project", pattern: "*.txt" }, { type: "list", path: "/workspace/project" }],
  grep: [{ path: "project", pattern: "new", include: "*.txt", literal: true }, { type: "search", path: "/workspace/project" }],
};

test.each(SANDBOX_TOOL_NAMES)("translates the recorded native %s input and Den action", name => {
  const [input, action] = cases[name];
  const schema = nativeSchemas[name];
  expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(Object.keys(input)));
  expect(Object.keys(input)).toEqual(expect.arrayContaining(schema.required));
  expect(computerActionForTool(name, translateComputerInput(name, input, "/workspace"))).toEqual(action);
});

function fixture() {
  const operations: string[] = [];
  const onRun = vi.fn((spec: RunSpec) => ({ stdout: spec.cwd ?? "", stderr: "", exitCode: 0 }));
  const provider = createFakeProvider({ onOperation: operation => operations.push(operation.name), onRun });
  const providerFactory = vi.fn(async () => provider);
  const options = { providerFactory, env: { DAYTONA_API_KEY: "test-fixture-key" } };
  const call = {
    connection: { provider: "daytona", externalId: "missing" }, scope: { surface: "whole_vm", folders: ["/workspace"] },
    tool: "shell", input: { command: "pwd", workdir: "project" }, signal: new AbortController().signal, label: "Build box",
  } satisfies Parameters<typeof runOnComputer>[0];
  return { operations, onRun, provider, providerFactory, options, call };
}

test("starts only the addressed VM, waits, then runs in the working folder", async () => {
  const { operations, onRun, provider, options, call } = fixture();
  const handle = await provider.create({ idempotencyKey: "build-box", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
  await provider.stop(handle, { timeoutMs: 1000 });
  const externalId = handle.ref.ref.sandboxId;
  if (!externalId) throw new Error("Missing fake VM id");
  const result = await runOnComputer({ ...call, connection: { ...call.connection, externalId } }, options);
  expect(operations).toEqual(["create", "stop", "get", "start", "inspect", "run"]);
  expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace/project" }));
  expect(result.content[0]?.text).toBe("/workspace/project");
});

test("does not create a missing VM", async () => {
  const { operations, options, call } = fixture();
  await expect(runOnComputer(call, options)).rejects.toThrow(/^Build box no longer exists at its provider\. Choose another computer\. Nothing ran there\.$/);
  expect(operations).toEqual(["get"]);
});

test.each(["lookup", "startup"])("reports a computer's error state during %s without dispatching", async step => {
  const { provider, options, call, onRun } = fixture();
  const handle = await provider.create({ idempotencyKey: "problem-box", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
  const externalId = handle.ref.ref.sandboxId;
  if (!externalId) throw new Error("Missing fake VM id");
  if (step === "lookup") vi.spyOn(provider, "get").mockResolvedValueOnce({ ...handle, state: "error" });
  else {
    await provider.stop(handle, { timeoutMs: 1000 });
    vi.spyOn(provider, "inspect").mockResolvedValueOnce({ ...handle, state: "error" });
  }
  await expect(runOnComputer({ ...call, connection: { ...call.connection, externalId } }, options)).rejects.toThrow(/^Build box has a problem at its provider\. Check it with the provider before trying again\. Nothing ran there\.$/);
  expect(onRun).not.toHaveBeenCalled();
});

test("missing or legacy consent, missing key, unsupported provider and background commands never acquire a provider", async () => {
  const { providerFactory, options, call } = fixture();
  await expect(runOnComputer(call, { ...options, env: {} })).rejects.toThrow(/^Build box needs its Daytona key on this machine before OpenWork can reach it\. Nothing ran there\.$/);
  await expect(runOnComputer({ ...call, connection: { provider: "openwork_desktop", externalId: "other" } }, options)).rejects.toThrow("Build box can't take work from other computers yet.");
  const rejectedScopes: Parameters<typeof runOnComputer>[0]["scope"][] = [undefined, null, { surface: "sandbox", folders: ["/workspace"] }];
  for (const scope of rejectedScopes) {
    await expect(runOnComputer({ ...call, scope }, options)).rejects.toThrow("owner's approval to access the entire computer");
  }
  await expect(runOnComputer({ ...call, input: { command: "pwd", background: true } }, options)).rejects.toThrow("Run it in the foreground");
  expect(providerFactory).not.toHaveBeenCalled();
});

test.each(["lookup", "start", "wait"])("a failure during %s reports that nothing ran", async step => {
  const { provider, options, call, onRun } = fixture();
  const diagnostic = new Error("private fixture diagnostic");
  const handle = await provider.create({ idempotencyKey: "cold-box", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
  const externalId = handle.ref.ref.sandboxId;
  if (!externalId) throw new Error("Missing fake VM id");
  if (step === "lookup") vi.spyOn(provider, "get").mockRejectedValueOnce(diagnostic);
  else {
    await provider.stop(handle, { timeoutMs: 1000 });
    if (step === "start") vi.spyOn(provider, "start").mockRejectedValueOnce(diagnostic);
    else vi.spyOn(provider, "inspect").mockResolvedValueOnce({ ...handle, state: "starting" }).mockRejectedValueOnce(diagnostic);
  }
  await expect(runOnComputer({ ...call, connection: { ...call.connection, externalId } }, options)).rejects.toThrow(/^OpenWork couldn't reach Build box\. Nothing ran there\.$/);
  expect(onRun).not.toHaveBeenCalled();
});

test.each(["error", "timeout", "cancel"])("a %s after dispatch reports an uncertain result and asks to check before retrying", async outcome => {
  const { provider, options, call, onRun } = fixture();
  const handle = await provider.create({ idempotencyKey: "interrupted-box", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
  const externalId = handle.ref.ref.sandboxId;
  if (!externalId) throw new Error("Missing fake VM id");
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ReturnType<typeof onRun>>();
  if (outcome === "cancel") {
    const run = provider.blocks?.run;
    if (!run) throw new Error("Missing fake shell capability");
    const installed = vi.spyOn(provider.blocks, "run");
    installed.mockImplementation(async (target, spec) => {
      const result = await run(target, spec);
      started.resolve();
      await release.promise;
      return result;
    });
  } else {
    onRun.mockImplementation(() => { throw new SandboxError({ providerId: provider.id, code: outcome === "timeout" ? "timeout" : "unknown", message: "private fixture diagnostic" }); });
  }
  const result = runOnComputer({ ...call, signal: controller.signal, connection: { ...call.connection, externalId } }, options);
  try {
    if (outcome === "cancel") {
      await started.promise;
      controller.abort();
    }
    const detail = outcome === "cancel" ? "OpenWork stopped waiting for Build box, but the operation may have partly run or already finished." : "OpenWork doesn't know how the operation ended on Build box. It may have finished.";
    await expect(result).rejects.toThrow(`${detail} Check the file or folder on that computer before running it again.`);
    expect(onRun).toHaveBeenCalledTimes(1);
  } finally { release.resolve({ stdout: "", stderr: "", exitCode: 0 }); }
});

test("reports specific file errors without exposing provider diagnostics", async () => {
  const { provider, options, call, onRun } = fixture();
  const handle = await provider.create({ idempotencyKey: "file-errors", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
  const externalId = handle.ref.ref.sandboxId;
  const files = provider.blocks?.files;
  if (!externalId || !files) throw new Error("Missing fake file capability");
  const connected = { ...call, connection: { ...call.connection, externalId } };
  await files.write(handle, "/workspace/notes.txt", new TextEncoder().encode("draft"), { timeoutMs: 1000 });
  await files.write(handle, "/workspace/invalid.txt", new Uint8Array([255]), { timeoutMs: 1000 });
  await expect(runOnComputer({ ...connected, tool: "read", input: { path: "missing.txt" } }, options)).rejects.toThrow("That path does not exist on this computer.");
  await expect(runOnComputer({ ...connected, tool: "read", input: { path: "invalid.txt" } }, options)).rejects.toThrow("not valid UTF-8 text");
  await expect(runOnComputer({ ...connected, tool: "edit", input: { path: "notes.txt", oldString: "absent", newString: "new" } }, options)).rejects.toThrow("oldString was not found");
  onRun.mockImplementationOnce(() => { throw new SandboxToolError("The computer reported test-fixture-key."); });
  await expect(runOnComputer(connected, options)).rejects.toThrow(/^The computer reported \[redacted\]\.$/);
  vi.spyOn(files, "stat").mockRejectedValue(new Error("private fixture diagnostic"));
  await expect(runOnComputer({ ...connected, tool: "read", input: { path: "notes.txt" } }, options)).rejects.toThrow(/^OpenWork doesn't know how the operation ended on Build box\. It may have finished\. Check the file or folder on that computer before running it again\.$/);
});

test.skipIf(process.platform === "win32")("lists directories and searches ordinary files inside the configured folder", async () => {
  const fixtureDir = await mkdtemp(join(await realpath(tmpdir()), "computer-search-"));
  const root = join(fixtureDir, "synthetic [files]");
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "alpha.txt"), "Release 12\nRelease 34\n");
    await writeFile(join(root, "nested", "beta.txt"), "release note\n");
    await writeFile(join(root, ".hidden.txt"), "draft\n");
    await writeFile(join(root, "other.md"), "release 56\n");
    const { provider, onRun, options, call } = fixture();
    const handle = await provider.create({ idempotencyKey: "file-search", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
    const externalId = handle.ref.ref.sandboxId;
    const files = provider.blocks?.files;
    if (!externalId || !files) throw new Error("Missing fake file capability");
    vi.spyOn(files, "stat").mockImplementation(async (_handle, path) => {
      expect(path).toBe(root);
      const info = await stat(path);
      return { size: info.size, kind: info.isDirectory() ? "directory" : "file" };
    });
    onRun.mockImplementation(({ command }) => {
      const result = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
      if (result.error) throw result.error;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
    });
    const connected: Parameters<typeof runOnComputer>[0] = { ...call, scope: { ...call.scope, folders: [root] }, connection: { ...call.connection, externalId } };
    const execute = (tool: typeof SANDBOX_TOOL_NAMES[number], input: unknown) => runOnComputer({ ...connected, tool, input }, options).then(result => result.content[0]?.text);
    expect(await execute("read", { path: root, offset: 2, limit: 2 })).toBe("alpha.txt\nnested\n");
    expect(provider.fake.count("files.read")).toBe(0);
    const names = (text: string | undefined) => text?.trim().split("\n").sort();
    expect(names(await execute("glob", { pattern: "**/*.txt" }))).toEqual([join(root, "alpha.txt"), join(root, "nested", "beta.txt")]);
    expect(names(await execute("glob", { pattern: "**/*.txt", hidden: true }))).toContain(join(root, ".hidden.txt"));
    expect(names(await execute("glob", { pattern: "**/*.txt", limit: 1 }))).toHaveLength(1);
    expect(await execute("grep", { pattern: "^release [0-9]+$", include: "*.txt", caseSensitive: false, limit: 1 })).toBe(`${join(root, "alpha.txt")}:1:Release 12\n`);
    expect(await execute("grep", { pattern: "not present", literal: true })).toBe("");
    await expect(execute("grep", { pattern: "[" })).rejects.toThrow("Could not use that grep pattern");
    await expect(execute("glob", { path: "missing-dir", pattern: "*.txt" })).rejects.toThrow("Search path is not a directory");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
