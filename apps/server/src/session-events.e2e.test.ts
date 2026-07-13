import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateOpenWorkSessionStreamFrame } from "@openwork/session-contracts";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function parseSseFrames(text: string) {
  return text
    .trim()
    .split(/\n\n+/)
    .map((chunk) => chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""))
      .join("\n"))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

async function startFixture() {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-events-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);

  const upstreamRequests: URL[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      upstreamRequests.push(url);
      if (url.pathname !== "/event") return new Response("not found", { status: 404 });
      const update = {
        id: "evt_update",
        type: "session.updated",
        properties: {
          info: {
            id: "ses_1",
            title: "Canonical stream",
            slug: "canonical-stream",
            directory: root,
            time: { created: 10, updated: 20 },
          },
        },
      };
      const future = {
        id: "evt_future",
        type: "session.future",
        properties: { vendorOnly: true },
      };
      return new Response([
        "id: upstream-1",
        `data: ${JSON.stringify(update)}`,
        "",
        "id: upstream-2",
        `data: ${JSON.stringify(future)}`,
        "",
        "",
      ].join("\n"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  }) as Served;
  stops.push(() => upstream.stop(true));

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_session_events",
    hostToken: "owt_session_events_host",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${upstream.port}`,
    }],
    authorizedRoots: [root],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const openwork = await startServer(config) as Served;
  stops.push(() => openwork.stop(true));
  return { openwork, token: config.token, upstreamRequests };
}

describe("canonical workspace session event stream", () => {
  test("adapts OpenCode events behind the authenticated OpenWork route", async () => {
    const fixture = await startFixture();
    const response = await fetch(
      `http://127.0.0.1:${fixture.openwork.port}/workspace/ws_1/sessions/events`,
      { headers: { Authorization: `Bearer ${fixture.token}` } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSseFrames(await response.text());
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      schemaVersion: 1,
      kind: "event",
      workspaceId: "ws_1",
      source: {
        adapterId: "builtin/opencode",
        eventType: "session.updated",
        eventId: "evt_update",
      },
      event: { kind: "session.updated", sessionId: "ses_1" },
    });
    expect(frames[1]).toMatchObject({
      kind: "event",
      source: { eventType: "session.future", eventId: "evt_future" },
      event: { kind: "unknown", sourceType: "session.future", reason: "unsupported_type" },
    });
    expect(frames[2]).toMatchObject({
      kind: "stream.error",
      error: { code: "OPENWORK_SESSION_STREAM_DISCONNECTED", retryable: true },
    });
    for (const frame of frames) expect(validateOpenWorkSessionStreamFrame(frame).ok).toBe(true);
    expect(fixture.upstreamRequests.some((url) => url.pathname === "/event")).toBe(true);
  });

  test("requires client authentication before subscribing upstream", async () => {
    const fixture = await startFixture();
    const response = await fetch(
      `http://127.0.0.1:${fixture.openwork.port}/workspace/ws_1/sessions/events`,
    );

    expect(response.status).toBe(401);
    expect(fixture.upstreamRequests).toHaveLength(0);
  });
});
