import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerObservabilityController } from "./observability.js";
import { startServer } from "./server.js";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function auth(token: string, observabilityToken?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(observabilityToken ? { "X-OpenWork-Observability-Token": observabilityToken } : {}),
  };
}

describe("observability routes", () => {
  test("rejects ordinary collaborators and accepts owner or engine-internal access", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-observability-routes-"));
    roots.push(root);
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      token: "owt_collaborator",
      hostToken: "owt_host",
      approval: { mode: "auto", timeoutMs: 1_000 },
      corsOrigins: ["*"],
      workspaces: [],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
      configPath: join(root, "server.json"),
    };
    const owner = await new TokenService(config).create("owner", { label: "test owner" });
    const observability = createServerObservabilityController();
    const server = await startServer(config, { observability });
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;

    const collaboratorResponse = await fetch(`${base}/observability/config`, {
      headers: auth(config.token),
    });
    expect(collaboratorResponse.status).toBe(403);

    const internalResponse = await fetch(`${base}/observability/config`, {
      headers: auth(config.token, observability.getInternalToken()),
    });
    expect(internalResponse.status).toBe(200);
    expect(internalResponse.headers.get("cache-control")).toContain("no-store");
    expect(await internalResponse.json()).toMatchObject({
      config: { enabled: false },
      collectionEpoch: 0,
      configRevision: 0,
    });

    const enableResponse = await fetch(`${base}/observability/config`, {
      method: "PUT",
      headers: auth(owner.token),
      body: JSON.stringify({
        expectedRevision: 0,
        config: { enabled: true, level: "debug", content: "full" },
      }),
    });
    expect(enableResponse.status).toBe(200);
    expect(await enableResponse.json()).toMatchObject({
      config: { enabled: true },
      collectionEpoch: 1,
      configRevision: 1,
    });

    const staleConfigWrite = await fetch(`${base}/observability/config`, {
      method: "PUT",
      headers: auth(owner.token),
      body: JSON.stringify({ expectedRevision: 0, config: { enabled: false } }),
    });
    expect(staleConfigWrite.status).toBe(409);

    const internalMutation = await fetch(`${base}/observability/config`, {
      method: "PUT",
      headers: auth(config.token, observability.getInternalToken()),
      body: JSON.stringify({ expectedRevision: 1, config: { content: "metadata" } }),
    });
    expect(internalMutation.status).toBe(403);

    const staleIngestResponse = await fetch(`${base}/observability/events`, {
      method: "POST",
      headers: auth(config.token, observability.getInternalToken()),
      body: JSON.stringify({
        events: [{
          level: "info",
          scope: "prompt",
          action: "system-prompt.snapshot",
          source: { runtime: "opencode", component: "openwork-observability" },
          data: { blockCount: 1, collectionEpoch: 0 },
          content: { kind: "system-prompt", value: { blocks: ["private prompt"] } },
        }],
      }),
    });
    expect(await staleIngestResponse.json()).toMatchObject({ ok: true, accepted: 0, rejected: 1 });

    const ingestResponse = await fetch(`${base}/observability/events`, {
      method: "POST",
      headers: auth(config.token, observability.getInternalToken()),
      body: JSON.stringify({
        events: [{
          level: "info",
          scope: "prompt",
          action: "system-prompt.snapshot",
          source: { runtime: "opencode", component: "openwork-observability" },
          data: { blockCount: 1, collectionEpoch: 1 },
          content: { kind: "system-prompt", value: { blocks: ["private prompt"] } },
        }],
      }),
    });
    expect(await ingestResponse.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });

    const rendererEvent = {
      level: "info",
      scope: "event",
      action: "sse.event",
      source: { runtime: "renderer", component: "session-sync" },
      data: { operation: "opencode-event-stream", type: "session.updated" },
      content: { kind: "json", value: { private: "renderer payload" } },
    };
    const staleRendererResponse = await fetch(`${base}/observability/events`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ collectionEpoch: 0, events: [rendererEvent] }),
    });
    expect(await staleRendererResponse.json()).toMatchObject({ ok: true, accepted: 0, rejected: 1 });
    const rendererResponse = await fetch(`${base}/observability/events`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ collectionEpoch: 1, events: [rendererEvent] }),
    });
    expect(await rendererResponse.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });

    const oversizedResponse = await fetch(`${base}/observability/events`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ events: [], padding: "x".repeat(4 * 1024 * 1024) }),
    });
    expect(oversizedResponse.status).toBe(413);
    // Drain the rejected response before issuing another request on Bun's
    // pooled connection; the server deliberately cancels the oversized body.
    await oversizedResponse.arrayBuffer();

    const eventsResponse = await fetch(`${base}/observability/events?after=0&limit=100`, {
      headers: auth(owner.token),
    });
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.headers.get("cache-control")).toContain("no-store");
    const eventsBody = await eventsResponse.json() as { events: Array<{ action: string }>; droppedCount: number };
    expect(eventsBody.events.some((event) => event.action === "observability.enabled")).toBe(true);
    expect(eventsBody.events.some((event) => event.action === "system-prompt.snapshot")).toBe(true);
    expect(eventsBody.events.some((event) => event.action === "sse.event")).toBe(true);
    expect(eventsBody.droppedCount).toBe(0);

    const internalRead = await fetch(`${base}/observability/events`, {
      headers: auth(config.token, observability.getInternalToken()),
    });
    expect(internalRead.status).toBe(403);

    const internalClear = await fetch(`${base}/observability/events`, {
      method: "DELETE",
      headers: auth(config.token, observability.getInternalToken()),
    });
    expect(internalClear.status).toBe(403);

    const clearResponse = await fetch(`${base}/observability/events`, {
      method: "DELETE",
      headers: auth(owner.token),
    });
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toMatchObject({
      ok: true,
      collectionEpoch: 2,
      configRevision: 2,
    });
    expect(observability.list()).toEqual([]);

    const preClearRendererResponse = await fetch(`${base}/observability/events`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ collectionEpoch: 1, events: [rendererEvent] }),
    });
    expect(await preClearRendererResponse.json()).toMatchObject({
      ok: true,
      accepted: 0,
      rejected: 1,
    });
    expect(observability.list()).toEqual([]);
  });
});
