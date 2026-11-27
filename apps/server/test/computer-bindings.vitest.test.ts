import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../src/types.js";
import { createComputerService } from "../src/computers/service.js";
import { computerListResponseSchema } from "@openwork/types/den/computers";

const computer = {
  id: "build", label: "Build box", ownerMemberId: "ada", kind: "registered_vm", provider: "daytona",
  state: "starts_when_needed", lastSeenAt: null, availability: "unknown", access: null,
  reach: { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders: ["/workspace"] } },
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
    expect(await service.binding("/local", "root")).toBeNull();
    expect(await service.select("/local", "root", " build BOX ")).toContain("Build box (Starts when needed)");
    const reopened = createComputerService({ ...config }, den);
    expect(await reopened.binding("/local", "root")).toEqual({ id: "build", label: "Build box", folder: "/workspace" });
    expect(await reopened.binding("/other", "root")).toBeNull();
    expect(await reopened.binding("/local", "unrelated")).toBeNull();
    await reopened.select("/local", "root", "this computer");
    expect(await service.binding("/local", "root")).toBeNull();
  } finally { await rm(temp, { recursive: true, force: true }); }
});
