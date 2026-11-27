import { test, expect, vi } from "vitest";
import { setupSandboxTools, type HostNativeTool, type SandboxPluginContext } from "../src/opencode-plugins/openwork-sandbox-v2.js";
import type { ComputerRouting } from "../src/opencode-plugins/computer-routing-v2.js";

async function fixture(initial: Awaited<ReturnType<ComputerRouting["status"]>>) {
  let feature = initial;
  const host = vi.fn(async () => "host result");
  const run = vi.fn<ComputerRouting["execute"]>(async ({ sessionId }, name) => {
    if (sessionId !== "root") return null;
    if (name !== "shell") throw new Error("That tool only works on this computer.");
    return { content: [{ type: "text", text: "remote result" }] };
  });
  const pick = vi.fn<ComputerRouting["select"]>(async () => "selected");
  const binding = vi.fn<ComputerRouting["binding"]>(async () => ({ id: "vm", label: "Build box", folder: "/workspace" }));
  const available = new Map<string, HostNativeTool>();
  let refresh = async () => {};
  const context: SandboxPluginContext = {
    options: {}, tool: {
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
    computers: { async status() { return feature; }, execute: run, select: pick, binding },
  });
  const invoke = (name: string, sessionID: string, input: unknown = { command: "pwd" }) => {
    const tool = available.get(name);
    if (!tool) throw new Error(`${name} is absent`);
    return tool.execute(input, { sessionID, signal: new AbortController().signal });
  };
  return { available, invoke, host, run, pick, async changeStatus(value: typeof initial) { feature = value; await refresh(); } };
}

test("bound and child sessions use their root; unbound chats and nonlocal tools keep the original executor", async () => {
  const f = await fixture("enabled");
  for (const session of ["root", "child"]) expect(await f.invoke("shell", session)).toEqual({ content: [{ type: "text", text: "remote result" }], output: {} });
  expect(f.run).toHaveBeenLastCalledWith({ sessionId: "root", directory: "/root-folder" }, "shell", { command: "pwd" }, expect.anything());
  await expect(f.invoke("patch", "child")).rejects.toThrow("only works on this computer");
  expect(f.host).not.toHaveBeenCalled();
  expect(await f.invoke("shell", "unbound")).toBe("host result");
  expect(await f.invoke("subagent", "root")).toBe("host result");
  await f.invoke("runs_on", "child", { computer: "Build box" });
  expect(f.pick).toHaveBeenCalledWith({ sessionId: "root", directory: "/root-folder" }, { computer: "Build box" }, expect.anything());
});

test("flag off does not offer runs_on or consult the computers bridge per tool", async () => {
  const f = await fixture("off");
  expect(f.available.has("runs_on")).toBe(false);
  expect(await f.invoke("shell", "root")).toBe("host result");
  expect(f.run).not.toHaveBeenCalled();
});

test("an unavailable Den does not convert bound tools into local tools", async () => {
  const f = await fixture("enabled");
  await f.changeStatus("unavailable");
  f.run.mockRejectedValueOnce(new Error("couldn't check access to your computers"));
  await expect(f.invoke("shell", "root")).rejects.toThrow("couldn't check access to your computers");
  expect(f.host).not.toHaveBeenCalled();
});
