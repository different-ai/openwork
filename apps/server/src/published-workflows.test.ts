import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublishedWorkflowsService } from "./published-workflows.js";
import type { ServerConfig } from "./types.js";

function createTestConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test-client-token",
    hostToken: "test-host-token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } as ServerConfig;
}

const dirs: string[] = [];
const priorStore = process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-published-workflows-"));
  dirs.push(dir);
  process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE = join(dir, "published-workflows.json");
});

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
  if (priorStore === undefined) {
    delete process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE;
  } else {
    process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE = priorStore;
  }
});

describe("PublishedWorkflowsService", () => {
  test("starts empty", async () => {
    const service = new PublishedWorkflowsService(createTestConfig());
    expect(await service.list()).toEqual([]);
  });

  test("create returns issued token + public record", async () => {
    const service = new PublishedWorkflowsService(createTestConfig());
    const issued = await service.create({
      workspaceId: "ws_a",
      skillName: "summarize",
      toolName: "summarize",
      description: "Summarize the input text",
    });

    expect(issued.id).toBeTruthy();
    expect(issued.token).toMatch(/^pwt_/);
    expect(issued.workspaceId).toBe("ws_a");
    expect((issued as Record<string, unknown>).tokenHash).toBeUndefined();
  });

  test("list filters by workspace and hides hash", async () => {
    const service = new PublishedWorkflowsService(createTestConfig());
    await service.create({ workspaceId: "ws_a", skillName: "a", toolName: "a", description: "x" });
    await service.create({ workspaceId: "ws_b", skillName: "b", toolName: "b", description: "y" });

    const onlyA = await service.list("ws_a");
    expect(onlyA.length).toBe(1);
    expect(onlyA[0].workspaceId).toBe("ws_a");
    expect((onlyA[0] as Record<string, unknown>).tokenHash).toBeUndefined();

    const all = await service.list();
    expect(all.length).toBe(2);
  });

  test("findByToken resolves the issued token, not arbitrary strings", async () => {
    const service = new PublishedWorkflowsService(createTestConfig());
    const issued = await service.create({
      workspaceId: "ws_a",
      skillName: "summarize",
      toolName: "summarize",
      description: "Summarize",
    });
    const found = await service.findByToken(issued.token);
    expect(found?.id).toBe(issued.id);
    expect(await service.findByToken("not-a-real-token")).toBeNull();
  });

  test("revoke removes the workflow and invalidates the token", async () => {
    const service = new PublishedWorkflowsService(createTestConfig());
    const issued = await service.create({
      workspaceId: "ws_a",
      skillName: "summarize",
      toolName: "summarize",
      description: "Summarize",
    });
    expect(await service.revoke(issued.id)).toBe(true);
    expect(await service.findByToken(issued.token)).toBeNull();
    expect(await service.list()).toEqual([]);
  });

  test("revoke returns false for unknown id", async () => {
    const service = new PublishedWorkflowsService(createTestConfig());
    expect(await service.revoke("ghost-id")).toBe(false);
  });

  test("persists across instances", async () => {
    const a = new PublishedWorkflowsService(createTestConfig());
    const issued = await a.create({
      workspaceId: "ws_a",
      skillName: "summarize",
      toolName: "summarize",
      description: "Summarize",
    });

    const b = new PublishedWorkflowsService(createTestConfig());
    const found = await b.findByToken(issued.token);
    expect(found?.id).toBe(issued.id);
    expect(found?.skillName).toBe("summarize");
  });
});
