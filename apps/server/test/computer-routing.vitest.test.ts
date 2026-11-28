import { test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupSandboxTools, type HostNativeTool, type SandboxPluginContext } from "../src/opencode-plugins/openwork-sandbox-v2.js";
import type { ComputerRouting } from "../src/opencode-plugins/computer-routing-v2.js";
import { createComputerService } from "../src/computers/service.js";
import { computerPermissionRequests, computerPermissionsSchema } from "../src/computers/permissions.js";
import { translateComputerInput } from "../src/computers/input.js";
import { shellPermissions } from "../src/computers/shell-permissions.js";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox-tool-host.js";
import { computerBridgeFixture, computersFixture } from "./fixtures/computers.js";

const root = { sessionId: "root", directory: "/root-folder" };
async function fixture(initial: Awaited<ReturnType<ComputerRouting["status"]>>, withPermission = true) {
  let feature = initial;
  const service = createComputerService(computersFixture("/root-folder"), {
    async authorize() { throw new Error("Den authorization should not be reached in this test"); },
    async status() { return "off"; }, async listComputers() { return { status: "off" }; },
  });
  const host = vi.fn(async () => "host result");
  const run = vi.fn<ComputerRouting["execute"]>(async () => ({ content: [{ type: "text", text: "remote result" }] }));
  const pick = vi.fn<ComputerRouting["select"]>(async () => "selected");
  const binding = vi.fn<ComputerRouting["binding"]>(async () => ({ id: "vm", label: "Build box", folder: "/workspace" }));
  const permissions = vi.fn<ComputerRouting["permissions"]>(async ({ sessionId }, name, input) => {
    const target = sessionId === "root" ? await binding(root) : null;
    return target ? service.permissions(target, name, input) : null;
  });
  const assert = vi.fn<NonNullable<SandboxPluginContext["permission"]>["assert"]>(async () => {});
  const available = new Map<string, HostNativeTool>();
  let refresh = async () => {};
  const context: SandboxPluginContext = {
    options: {}, ...(withPermission ? { permission: { assert } } : {}), tool: {
      async transform(transform) {
        const native = ["shell", "patch", "subagent"].map(id => ({ id, name: id, input: {}, description: id, execute: host }));
        transform({ list: () => native, remove: id => available.delete(id), add: tool => { available.set(tool.name, tool); } });
        return { async dispose() {} };
      },
      async reload() {},
    }, session: {
      async get({ sessionID }) { return { ...(sessionID === "child" ? { parentID: "root" } : {}), location: { directory: "/root-folder" } }; },
      async hook(name, callback) {
        if (name === "prompt") refresh = async () => callback({ tools: {}, system: [] });
        return { async dispose() {} };
      },
    },
  };
  await setupSandboxTools(context, {
    async status() { return "off"; },
    async execute() { throw new Error("local sandbox must not run"); },
    computers: { async status() { return feature; }, execute: run, select: pick, binding, permissions },
  });
  const invoke = (name: string, sessionID: string, input: unknown = { command: "pwd" }, signal = new AbortController().signal) => {
    const tool = available.get(name);
    if (!tool) throw new Error(`${name} is absent`);
    return tool.execute(input, { sessionID, signal, id: "call-shell", messageID: "msg-shell", agent: "worker" });
  };
  return { available, invoke, host, run, assert, pick, permissions, async changeStatus(value: typeof initial) { feature = value; await refresh(); } };
}

test("a child uses its root's computer but asserts permission as the invoking child before dispatch", async () => {
  const f = await fixture("enabled");
  const asked = Promise.withResolvers<void>();
  const approved = Promise.withResolvers<void>();
  f.assert.mockImplementationOnce(() => { asked.resolve(); return approved.promise; });
  const result = f.invoke("shell", "child");
  await asked.promise;
  expect(f.assert).toHaveBeenCalledExactlyOnceWith({
    sessionID: "child", agent: "worker", source: { type: "tool", id: "call-shell", messageID: "msg-shell" },
    action: "shell", resources: ["pwd"], save: ["pwd *"], metadata: { computer: "Build box" },
  });
  expect(f.permissions).toHaveBeenCalledExactlyOnceWith(root, "shell", { command: "pwd" }, expect.any(AbortSignal));
  expect(f.run).not.toHaveBeenCalled();
  approved.resolve();
  expect(await result).toEqual({ content: [{ type: "text", text: "remote result" }], output: {} });
  expect(f.run).toHaveBeenCalledExactlyOnceWith(root, expect.objectContaining({ bindingId: "vm" }), "shell", { command: "pwd" }, expect.any(AbortSignal));
  expect(f.host).not.toHaveBeenCalled();
});

test("the engine's rejection propagates without any remote or local execution", async () => {
  const f = await fixture("enabled");
  const declined = new Error("Fixture engine decline");
  f.assert.mockRejectedValueOnce(declined);
  await expect(f.invoke("shell", "root")).rejects.toBe(declined);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.host).not.toHaveBeenCalled();
});

test("cancelling during approval prevents dispatch even if the assertion then resolves", async () => {
  const f = await fixture("enabled");
  const controller = new AbortController();
  const stopped = new Error("Fixture stop");
  f.assert.mockImplementationOnce(async () => controller.abort(stopped));
  await expect(f.invoke("shell", "root", { command: "pwd" }, controller.signal)).rejects.toBe(stopped);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.host).not.toHaveBeenCalled();
});

test("bound local-only tools refuse; unbound chats and other tools keep the original executor", async () => {
  const f = await fixture("enabled");
  await expect(f.invoke("patch", "child")).rejects.toThrow("only works on this computer");
  expect(f.host).not.toHaveBeenCalled();
  expect(await f.invoke("shell", "unbound")).toBe("host result");
  expect(await f.invoke("subagent", "root")).toBe("host result");
  expect(f.assert).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  await f.invoke("runs_on", "child", { computer: "Build box" });
  expect(f.pick).toHaveBeenCalledWith(root, { computer: "Build box" }, expect.any(AbortSignal));
});

test("flag off does not offer runs_on or consult the computers bridge per tool", async () => {
  const f = await fixture("off");
  expect(f.available.has("runs_on")).toBe(false);
  expect(await f.invoke("shell", "root")).toBe("host result");
  expect(f.permissions).not.toHaveBeenCalled();
  expect(f.assert).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});

test("an unavailable Den does not convert bound tools into local tools", async () => {
  const f = await fixture("enabled");
  await f.changeStatus("unavailable");
  f.run.mockRejectedValueOnce(new Error("couldn't check access to your computers"));
  await expect(f.invoke("shell", "root")).rejects.toThrow("couldn't check access to your computers");
  expect(f.host).not.toHaveBeenCalled();
});

test("an engine without permission support fails closed only for a bound tool", async () => {
  const f = await fixture("enabled", false);
  await expect(f.invoke("shell", "root")).rejects.toThrow("Nothing ran on the other computer. Update OpenWork");
  expect(f.run).not.toHaveBeenCalled();
  expect(f.host).not.toHaveBeenCalled();
  expect(await f.invoke("shell", "unbound")).toBe("host result");
});

test.each(["Second box", "this computer", "Build box"])("the bridge rejects stale approval after selecting %s", async selection => {
  const directory = await mkdtemp(join(tmpdir(), "computer-binding-test-"));
  const f = await computerBridgeFixture(computersFixture(directory));
  const request = (operation: string, bindingId?: string) => fetch(f.bridge.url, {
    method: "POST", headers: { Authorization: `Bearer ${f.bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, directory, sessionId: "fixture-session", name: "shell", input: { command: "pwd" }, bindingId }),
  });
  try {
    const local = await request("computer-permissions");
    expect(await local.json()).toEqual({ approval: null });
    await f.service.select(directory, "fixture-session", "Build box");
    const initial = await request("computer-permissions");
    const { approval } = await initial.json();
    const { bindingId } = computerPermissionsSchema.parse(approval);
    await f.service.select(directory, "fixture-session", selection);
    const stale = await request("computer-execute", bindingId);
    expect(stale.ok).toBe(false);
    expect(await stale.json()).toEqual({ error: "This chat's computer changed while waiting for approval. Nothing ran." });
    expect(f.dispatched).toEqual([]);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

const nativePermissions = {
  shell: { input: { command: "git status --short" }, action: "shell", resources: ["git status --short"], save: ["git status *"] },
  read: { input: { path: "../notes.txt" }, action: "read", resources: ["/notes.txt"], save: ["*"] },
  write: { input: { path: "a.txt", content: "draft" }, action: "edit", resources: ["/workspace/a.txt"], save: ["*"] },
  edit: { input: { path: "/records/a.txt", oldString: "draft", newString: "final" }, action: "edit", resources: ["/records/a.txt"], save: ["*"] },
  glob: { input: { path: "project", pattern: "**/*.txt" }, action: "glob", resources: ["**/*.txt"], save: ["*"] },
  grep: { input: { path: "/records", pattern: "^draft" }, action: "grep", resources: ["^draft"], save: ["*"] },
};

test.each(SANDBOX_TOOL_NAMES)("uses the native action, resources and save pattern for %s", tool => {
  const { input, ...request } = nativePermissions[tool];
  expect(computerPermissionRequests(tool, translateComputerInput(tool, input, "/workspace"))).toEqual([request]);
});

test.each([
  { command: "pwd", resources: ["pwd"], save: ["pwd *"] },
  { command: "git status && echo draft", resources: ["git status", "echo draft"], save: ["git status *", "echo *"] },
  { command: "git diff || pnpm run build", resources: ["git diff", "pnpm run build"], save: ["git diff *", "pnpm run build *"] },
  { command: "  git status;  ls -a ;", resources: ["git status", "ls -a"], save: ["git status *", "ls *"] },
  { command: "cat notes.txt|grep draft", resources: ["cat notes.txt", "grep draft"], save: ["cat *", "grep *"] },
  { command: `echo 'a && b' "c || d" ';' "|" | cat`, resources: [`echo 'a && b' "c || d" ';' "|"`, "cat"], save: ["echo *", "cat *"] },
  { command: "git config user.email\npwd", resources: ["git config user.email", "pwd"], save: ["git config user.email *", "pwd *"] },
])("matches OpenCode's shell keys for $command", ({ command, resources, save }) => {
  expect(shellPermissions(command)).toEqual({ action: "shell", resources, save });
});

test.each(["echo $(pwd)", "(echo ok)", "cat <<END\nnote\nEND", "echo 'unfinished", "git status &&", "echo `pwd`", "echo >notes.txt", "if true; then echo ok; fi"])("requires approval for the entire raw command: %s", command => {
  expect(shellPermissions(command)).toEqual({ action: "shell", resources: [command], save: process.platform === "win32" ? [] : [command], confirm: true });
});

test.each(["echo $(cat *.txt)", "echo $(cat data?.txt)", "echo $(cat /workspace/a.txt)", "echo \\; cat"])("does not save an ambiguous shell pattern: %s", command => {
  expect(shellPermissions(command)).toEqual({ action: "shell", resources: [command], save: [], confirm: true });
});
