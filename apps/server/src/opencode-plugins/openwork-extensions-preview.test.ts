import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";

const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;
const stops: Array<() => void> = [];

const searchResultSchema = z.object({
  ok: z.literal(true),
  scannedSessions: z.number(),
  results: z.array(z.object({
    workspaceId: z.string(),
    sessionId: z.string(),
    kind: z.string(),
    role: z.string().optional(),
    snippet: z.object({ match: z.string() }).passthrough(),
  }).passthrough()),
}).passthrough();

const readResultSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    text: z.string(),
  }).passthrough()),
}).passthrough();

afterEach(() => {
  while (stops.length) stops.pop()?.();
  if (originalServerUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = originalServerToken;
});

function startFakeOpenWorkServer() {
  const requests: Array<{ pathname: string; search: string; authorization: string | null }> = [];

  const workspaceOne = { id: "ws_1", name: "Main", path: "/tmp/main" };
  const workspaceTwo = { id: "ws_2", name: "Archive", displayName: "Archive", path: "/tmp/archive" };
  const sessionAlpha = { id: "ses_alpha", title: "Alpha planning", time: { created: 100, updated: 300 } };
  const sessionBeta = { id: "ses_beta", title: "Neon backlog", time: { created: 50, updated: 200 } };
  const sessionArchive = { id: "ses_archive", title: "Archive decisions", time: { created: 10, updated: 100 } };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.get("authorization"),
      });

      if (request.headers.get("authorization") !== "Bearer test-token") {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }

      if (url.pathname === "/workspaces") {
        return Response.json({ items: [workspaceOne, workspaceTwo], workspaces: [workspaceOne, workspaceTwo] });
      }

      if (url.pathname === "/workspace/ws_1/sessions") {
        return Response.json({ items: [sessionAlpha, sessionBeta] });
      }
      if (url.pathname === "/workspace/ws_2/sessions") {
        return Response.json({ items: [sessionArchive] });
      }

      if (url.pathname === "/workspace/ws_1/sessions/ses_alpha") return Response.json({ item: sessionAlpha });
      if (url.pathname === "/workspace/ws_1/sessions/ses_beta") return Response.json({ item: sessionBeta });
      if (url.pathname === "/workspace/ws_2/sessions/ses_archive") return Response.json({ item: sessionArchive });

      if (url.pathname === "/workspace/ws_1/sessions/ses_alpha/messages") {
        return Response.json({
          items: [
            {
              info: { id: "msg_assistant", role: "assistant", time: { created: 301 } },
              parts: [{ type: "text", text: "The launch checklist can wait." }],
            },
            {
              info: { id: "msg_user", role: "user", time: { created: 302 } },
              parts: [{ type: "text", text: "Please remember the raven launch checklist." }],
            },
          ],
        });
      }
      if (url.pathname === "/workspace/ws_1/sessions/ses_beta/messages") {
        return Response.json({ items: [] });
      }
      if (url.pathname === "/workspace/ws_2/sessions/ses_archive/messages") {
        return Response.json({
          items: [
            {
              info: { id: "msg_old", role: "assistant", time: { created: 101 } },
              parts: [{ type: "text", text: "Ignored implementation note", ignored: true }],
            },
            {
              info: { id: "msg_latest", role: "assistant", time: { created: 102 } },
              parts: [{ type: "text", text: "We decided to ship the archive importer first." }],
            },
          ],
        });
      }

      return Response.json({ message: "Not found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.OPENWORK_SERVER_TOKEN = "test-token";
  return { requests };
}

describe("OpenWorkExtensionsPreview session tools", () => {
  test("searches past chat transcript text and prefers the user's matching message", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_session_search.execute({
      query: "raven launch",
      limit: 5,
      scanLimit: 10,
    });
    const parsed = searchResultSchema.parse(JSON.parse(output));

    expect(parsed.scannedSessions).toBe(3);
    expect(parsed.results[0]).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "ses_alpha",
      kind: "message",
      role: "user",
    });
    expect(parsed.results[0]?.snippet.match.toLowerCase()).toBe("raven launch");
    expect(fake.requests.some((request) => request.pathname === "/workspace/ws_1/sessions/ses_alpha/messages" && request.search === "?limit=400")).toBe(true);
  });

  test("reads a transcript by session id without opening the UI", async () => {
    startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_session_read.execute({
      sessionId: "ses_archive",
      count: 2,
    });
    const parsed = readResultSchema.parse(JSON.parse(output));

    expect(parsed).toMatchObject({
      workspaceId: "ws_2",
      sessionId: "ses_archive",
      title: "Archive decisions",
    });
    expect(parsed.messages).toEqual([
      {
        index: 1,
        id: "msg_latest",
        role: "assistant",
        text: "We decided to ship the archive importer first.",
      },
    ]);
  });
});
