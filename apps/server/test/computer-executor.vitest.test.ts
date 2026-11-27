import { test, expect, vi } from "vitest";
import { createFakeProvider } from "@openwork/sandbox/testing";
import type { RunSpec } from "@openwork/sandbox";
import { runOnComputer } from "../src/computers/executor.js";
import { computerActionForTool, translateComputerInput } from "../src/computers/input.js";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox-tool-host.js";
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
    connection: { provider: "daytona", externalId: "missing" }, scope: { surface: "sandbox", folders: ["/workspace", "/data"] },
    tool: "shell", input: { command: "pwd", workdir: "project" }, signal: new AbortController().signal, label: "Build box",
  } satisfies Parameters<typeof runOnComputer>[0];
  return { operations, onRun, provider, providerFactory, options, call };
}

test("starts only the addressed VM, waits, then runs in the first shared folder", async () => {
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
  await expect(runOnComputer(call, options)).rejects.toThrow("Build box no longer exists at its provider.");
  expect(operations).toEqual(["get"]);
});

test("missing key, unsupported provider, outside paths and background commands never acquire a provider", async () => {
  const { providerFactory, options, call } = fixture();
  await expect(runOnComputer(call, { ...options, env: {} })).rejects.toThrow("needs its Daytona key");
  await expect(runOnComputer({ ...call, connection: { provider: "freestyle", externalId: "other" } }, options)).rejects.toThrow("can't reach freestyle computers yet");
  await expect(runOnComputer({ ...call, input: { command: "pwd", workdir: "/workspace-sibling" } }, options)).rejects.toThrow("isn't shared with me");
  await expect(runOnComputer({ ...call, input: { command: "pwd", background: true } }, options)).rejects.toThrow("Run it in the foreground");
  expect(providerFactory).not.toHaveBeenCalled();
});
