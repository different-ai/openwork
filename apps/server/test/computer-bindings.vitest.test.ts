import { test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../src/types.js";
import { computersFixture } from "./fixtures/computers.js";
import type { ComputerSourceQueue } from "../src/computers/den.js";
import { createComputerService } from "../src/computers/service.js";
import { computerListResponseSchema } from "@openwork/types/den/computers";

const computer = {
  id: "build", label: "Build box", ownerMemberId: "ada", kind: "registered_vm", provider: "daytona",
  state: "starts_when_needed", lastSeenAt: null, availability: "unknown", access: null,
  reach: { outcome: "allow", route: "checked", scope: { surface: "whole_vm", folders: ["/workspace"] } },
};

test("runs_on lists, refuses, asks about ambiguity, binds by name and clears just that root", async () => {
  const temp = await mkdtemp(join(tmpdir(), "computer-binding-"));
  try {
    const config: ServerConfig = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(temp, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    const { computers } = computerListResponseSchema.parse({ computers: [computer, { ...computer, id: "other", label: "Other build box" }, {
      ...computer, id: "private", label: "Private box", reach: {
        outcome: "refuse", layer: "computer", code: "computer_not_allowed", changeableBy: "computer_owner", message: "Private box doesn't take work from other computers.",
      },
    }, {
      ...computer, id: "legacy", label: "Legacy VM", reach: { ...computer.reach, scope: { surface: "sandbox", folders: ["/workspace"] } },
    }, {
      ...computer, id: "desk", label: "Desk computer", kind: "member_machine", provider: "openwork_desktop", state: "online", availability: "online",
    }] });
    const den = {
      async status(): Promise<"enabled"> { return "enabled"; },
      async listComputers() { return { status: "enabled", computers } satisfies { status: "enabled"; computers: unknown }; },
      async authorize() { throw new Error("Selection should use the list response"); },
    };
    const service = createComputerService(config, den);
    expect(await service.select("/local", "root")).toContain("This chat runs on this computer");
    expect(await service.select("/local", "root", "unknown")).toContain("couldn't find");
    expect(await service.select("/local", "root", "build")).toContain("Ask which one to use");
    expect(await service.select("/local", "root", "Private box")).toBe("Private box doesn't take work from other computers.");
    expect(await service.select("/local", "root", "Legacy VM")).toContain("owner's approval to access the entire computer");
    expect(await service.select("/local", "root", "Desk computer")).toBe("This computer hasn't finished connecting to your organization yet. Try again in a moment. Nothing ran.");
    expect(await service.binding("/local", "root")).toBeNull();
    expect(await service.select("/local", "root", " build BOX ")).toContain("Build box (Starts when needed)");
    const reopened = createComputerService({ ...config }, den);
    expect(await reopened.binding("/local", "root")).toMatchObject({ id: "build", label: "Build box", folder: "/workspace" });
    expect(await reopened.binding("/other", "root")).toBeNull();
    expect(await reopened.binding("/local", "unrelated")).toBeNull();
    await reopened.select("/local", "root", "this computer");
    expect(await service.binding("/local", "root")).toBeNull();
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("chooses shared folders with their access, passes through refusals and explains offline machines", async () => {
  const root = await mkdtemp(join(tmpdir(), "personal-computer-binding-"));
  const config = computersFixture(root);
  const now = Date.now();
  const personal = {
    ...computer, kind: "member_machine", provider: "openwork_desktop", availability: "online", state: "online", id: "target", label: "Studio Mac",
    reach: { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders: ["/notes", "/drafts"], writableFolders: ["/drafts"] } },
  };
  const { computers } = computerListResponseSchema.parse({ computers: [personal, computer, {
    ...personal, id: "travel", label: "Travel MacBook", state: "offline", availability: "offline", lastSeenAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  }, {
    ...personal, id: "denied", label: "Private desktop", reach: { outcome: "refuse", layer: "source", code: "source_not_allowed", changeableBy: "computer_owner", message: "This desktop isn't shared with you." },
  }] });
  const authorize = vi.fn(async () => { throw new Error("Personal tool calls must not authorize separately"); });
  const enqueue = vi.fn<ComputerSourceQueue["enqueue"]>(async () => ({ state: "done", id: "cmd", output: "read notes", exitCode: 0, truncated: false }));
  const service = createComputerService(config, {
    async status() { return "enabled"; }, async listComputers() { return { status: "enabled", computers }; }, authorize,
    sourceQueue: () => ({ enqueue, async follow() { throw new Error("Completed immediately"); } }),
  });
  try {
    expect(await service.select(root, "chat")).toContain("Build box (Starts when needed), Travel MacBook (Offline, last seen 2 hours ago)");
    expect(await service.select(root, "chat", "Travel MacBook")).toBe("Travel MacBook is offline, last seen 2 hours ago. Nothing ran there.");
    expect(await service.select(root, "chat", "Private desktop")).toBe("This desktop isn't shared with you.");
    expect(await service.binding(root, "chat")).toBeNull();
    expect(await service.select(root, "chat", "Studio Mac")).toContain("/notes (read-only), /drafts (can edit)");
    const binding = await service.binding(root, "chat");
    if (!binding) throw new Error("Missing personal-computer binding");
    expect(binding).toMatchObject({ folder: "/notes", kind: "member_machine", provider: "openwork_desktop" });
    const { bindingId } = service.permissions(binding, "read", { path: "a.txt" });
    const signal = new AbortController().signal;
    expect((await service.execute(root, "chat", bindingId, "read", { path: "a.txt" }, signal)).content).toEqual([{ type: "text", text: "read notes" }]);
    expect(authorize).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith("target", { tool: "read", input: { path: "/notes/a.txt", offset: 1, limit: 2000 } }, signal);
  } finally { await rm(root, { recursive: true, force: true }); }
});
