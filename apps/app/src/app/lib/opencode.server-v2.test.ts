// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";
import { createClient, unwrap } from "./opencode";

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

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }) as Served;
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

describe("createClient Server V2 session routing", () => {
  test("routes local session reads and SSE through Server V2 when sessionRouting is provided", async () => {
    const calls: string[] = [];

    const opencodeBaseUrl = startServer((request) => {
      const url = new URL(request.url);
      calls.push(`opencode:${url.pathname}`);
      if (url.pathname === "/health") {
        return Response.json({ healthy: true, version: "1.0.0" });
      }
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    });

    const openworkBaseUrl = startServer((request) => {
      const url = new URL(request.url);
      calls.push(`openwork:${url.pathname}`);

      if (url.pathname === "/workspaces/ws_local/sessions") {
        return Response.json({
          ok: true,
          data: {
            items: [
              {
                id: "ses_local",
                title: "Local Session",
                directory: "/tmp/local",
              },
            ],
          },
          meta: { requestId: "owreq_1", timestamp: new Date().toISOString() },
        });
      }

      if (url.pathname === "/workspaces/ws_local/events") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_local" } })}\n\n`);
            controller.close();
          },
        }), {
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }

      return Response.json({ ok: false, error: { code: "not_found", message: "Not found", requestId: "owreq_2" } }, { status: 404 });
    });

    const client = createClient(opencodeBaseUrl, "/tmp/local", {
      sessionRouting: {
        baseUrl: openworkBaseUrl,
        token: "client-token",
        workspaceId: "ws_local",
      },
    });

    const sessions = unwrap(await client.session.list({ roots: true }));
    expect(sessions[0]?.id).toBe("ses_local");

    const subscription = await client.event.subscribe(undefined, { signal: AbortSignal.timeout(1000) });
    const first = await subscription.stream.next();
    expect(first.value).toEqual({ type: "session.idle", properties: { sessionID: "ses_local" } });

    expect(calls).toContain("openwork:/workspaces/ws_local/sessions");
    expect(calls).not.toContain("opencode:/session");
  });

  test("falls back to mounted legacy OpenCode routes when the Server V2 session surface is unavailable", async () => {
    const calls: string[] = [];

    const remoteBaseUrl = startServer((request) => {
      const url = new URL(request.url);
      calls.push(url.pathname);

      if (url.pathname === "/workspaces/alpha/sessions") {
        return Response.json({ ok: false, error: { code: "not_found", message: "Not found", requestId: "owreq_3" } }, { status: 404 });
      }

      if (url.pathname === "/w/alpha/opencode/session") {
        return Response.json([
          {
            id: "ses_remote",
            title: "Remote Session",
            directory: "/srv/alpha",
          },
        ]);
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    });

    const client = createClient(`${remoteBaseUrl}/w/alpha/opencode`, undefined, {
      mode: "openwork",
      token: "remote-token",
    });

    const sessions = unwrap(await client.session.list({ roots: true }));
    expect(sessions[0]?.id).toBe("ses_remote");
    expect(calls).toContain("/workspaces/alpha/sessions");
    expect(calls).toContain("/w/alpha/opencode/session");
  });
});
