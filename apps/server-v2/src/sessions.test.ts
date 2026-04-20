import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "./app.js";
import { createAppDependencies } from "./context/app-dependencies.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
});

function createTestApp() {
  const dependencies = createAppDependencies({
    environment: "test",
    inMemory: true,
    legacy: {
      desktopDataDir: `/tmp/openwork-server-v2-phase6-desktop-${Math.random().toString(16).slice(2)}`,
      orchestratorDataDir: `/tmp/openwork-server-v2-phase6-orchestrator-${Math.random().toString(16).slice(2)}`,
    },
    runtime: {
      bootstrapPolicy: "disabled",
    },
    startedAt: new Date("2026-04-14T00:00:00.000Z"),
    version: "0.0.0-test",
  });

  return {
    app: createApp({ dependencies }),
    dependencies,
  };
}

function withMockOpencodeBaseUrl(dependencies: ReturnType<typeof createAppDependencies>, baseUrl: string) {
  dependencies.services.runtime.getOpencodeHealth = () => ({
    baseUrl,
    binaryPath: null,
    diagnostics: { combined: [], stderr: [], stdout: [], totalLines: 0, truncated: false },
    lastError: null,
    lastExit: null,
    lastReadyAt: null,
    lastStartedAt: null,
    manifest: null,
    pid: 123,
    running: true,
    source: "development",
    status: "running",
    version: "1.2.3",
  });
}

function startMockOpencode(options?: { expectBearer?: string; mountPrefix?: string }) {
  const requests: Array<{ method: string; pathname: string; authorization: string | null; body: unknown }> = [];
  const prefix = options?.mountPrefix?.replace(/\/+$/, "") ?? "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const pathname = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : url.pathname;
      const authorization = request.headers.get("authorization");
      requests.push({ method: request.method, pathname, authorization, body: null });

      if (options?.expectBearer) {
        expect(authorization).toBe(`Bearer ${options.expectBearer}`);
      }

      if (pathname === "/event") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })}\n\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_1" } })}\n\n`);
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }

      if (pathname === "/session" && request.method === "GET") {
        return Response.json([
          {
            id: "ses_1",
            title: "Session One",
            directory: "/tmp/workspace",
            time: { created: 100, updated: 200 },
          },
        ]);
      }

      if (pathname === "/session/status" && request.method === "GET") {
        return Response.json({ ses_1: { type: "busy" } });
      }

      if (pathname === "/session" && request.method === "POST") {
        return Response.json({
          id: "ses_created",
          title: "Created Session",
          directory: "/tmp/workspace",
          time: { created: 300, updated: 300 },
        });
      }

      if (pathname === "/session/ses_1" && request.method === "GET") {
        return Response.json({
          id: "ses_1",
          title: "Session One",
          directory: "/tmp/workspace",
          time: { created: 100, updated: 200 },
        });
      }

      if (pathname === "/session/ses_1" && request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          title: "Renamed Session",
          directory: "/tmp/workspace",
          time: { created: 100, updated: 250 },
        });
      }

      if (pathname === "/session/ses_1" && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      if (pathname === "/session/ses_1/message" && request.method === "GET") {
        return Response.json([
          {
            info: {
              id: "msg_1",
              role: "assistant",
              sessionID: "ses_1",
            },
            parts: [
              {
                id: "prt_1",
                messageID: "msg_1",
                sessionID: "ses_1",
                type: "text",
                text: "hello",
              },
            ],
          },
        ]);
      }

      if (pathname === "/session/ses_1/message/msg_1" && request.method === "GET") {
        return Response.json({
          info: {
            id: "msg_1",
            role: "assistant",
            sessionID: "ses_1",
          },
          parts: [
            {
              id: "prt_1",
              messageID: "msg_1",
              sessionID: "ses_1",
              type: "text",
              text: "hello",
            },
          ],
        });
      }

      if (pathname === "/session/ses_1/todo" && request.method === "GET") {
        return Response.json([
          { content: "Ship Phase 6", priority: "high", status: "completed" },
        ]);
      }

      if (pathname === "/session/ses_1/prompt_async" && request.method === "POST") {
        return Response.json({ ok: true });
      }

      if (pathname === "/session/ses_1/command" && request.method === "POST") {
        return Response.json({ ok: true });
      }

      if (pathname === "/session/ses_1/revert" && request.method === "POST") {
        return Response.json({
          id: "ses_1",
          title: "Reverted Session",
          directory: "/tmp/workspace",
          time: { created: 100, updated: 260 },
        });
      }

      if (pathname === "/session/ses_1/unrevert" && request.method === "POST") {
        return Response.json({
          id: "ses_1",
          title: "Restored Session",
          directory: "/tmp/workspace",
          time: { created: 100, updated: 270 },
        });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;

  stops.push(() => server.stop(true));
  return {
    requests,
    url: `http://127.0.0.1:${server.port}`,
  };
}

describe("workspace session routes", () => {
  test("serves local workspace session reads, writes, and streaming", async () => {
    const mock = startMockOpencode();
    const { app, dependencies } = createTestApp();
    const workspace = dependencies.persistence.registry.importLocalWorkspace({
      dataDir: "/tmp/workspace",
      displayName: "Local Workspace",
      status: "ready",
    });
    withMockOpencodeBaseUrl(dependencies, mock.url);

    const listResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions?roots=true&limit=1`);
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).data.items[0].id).toBe("ses_1");

    const snapshotResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions/ses_1/snapshot?limit=5`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.data.session.id).toBe("ses_1");
    expect(snapshot.data.status.type).toBe("busy");
    expect(snapshot.data.todos[0].content).toBe("Ship Phase 6");

    const createResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Create" }),
    });
    expect(createResponse.status).toBe(200);
    expect((await createResponse.json()).data.id).toBe("ses_created");

    const updateResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions/ses_1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Rename" }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).data.title).toBe("Renamed Session");

    const promptResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions/ses_1/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "Hello" }] }),
    });
    expect(promptResponse.status).toBe(200);
    expect((await promptResponse.json()).data.accepted).toBe(true);

    const revertResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions/ses_1/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: "msg_1" }),
    });
    expect(revertResponse.status).toBe(200);
    expect((await revertResponse.json()).data.title).toBe("Reverted Session");

    const eventsResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/events`);
    expect(eventsResponse.status).toBe(200);
    const eventsBody = await eventsResponse.text();
    expect(eventsBody).toContain("session.status");
    expect(eventsBody).toContain("session.idle");
  });

  test("routes remote workspace sessions through the mounted remote backend", async () => {
    const remote = startMockOpencode({ expectBearer: "secret", mountPrefix: "/w/alpha/opencode" });
    const { app, dependencies } = createTestApp();
    const workspace = dependencies.persistence.registry.importRemoteWorkspace({
      baseUrl: `${remote.url}/w/alpha/opencode`,
      directory: "/srv/remote-alpha",
      displayName: "Remote Alpha",
      legacyNotes: { source: "test" },
      remoteType: "openwork",
      remoteWorkspaceId: "alpha",
      serverAuth: { openworkToken: "secret" },
      serverBaseUrl: remote.url,
      serverHostingKind: "self_hosted",
      serverLabel: "remote.example.com",
      workspaceStatus: "ready",
    });

    const listResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions`);
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).data.items[0].id).toBe("ses_1");

    const commandResponse = await app.request(`http://openwork.local/workspaces/${workspace.id}/sessions/ses_1/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "review" }),
    });
    expect(commandResponse.status).toBe(200);
    expect((await commandResponse.json()).data.accepted).toBe(true);
  });
});
