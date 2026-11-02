import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError, formatError } from "../src/errors.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import { registerFileRoutes } from "../src/routes/files.js";
import { serve, type ServeResult } from "../src/serve-node.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

const INBOX = ".opencode/openwork/inbox";
const CAP = 1024;

let root = "";
let server: ServeResult;
let base = "";

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function inboxUrl(path?: string) {
  return `${base}/workspace/w1/inbox${path ? `?path=${encodeURIComponent(path)}` : ""}`;
}

async function inboxEntries(): Promise<string[]> {
  const entries = await readdir(join(root, INBOX), { recursive: true }).catch(() => [] as string[]);
  return entries.sort();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openwork-inbox-upload-"));
  const routes: Route[] = [];
  registerFileRoutes({
    routes,
    config: {} as ServerConfig,
    jsonResponse,
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireApproval: async () => undefined,
    requireClientScope: () => undefined,
    resolveWorkspace: async () => ({ id: "w1", path: root }) as WorkspaceInfo,
    resolveInboxEnabled: () => true,
    resolveOutboxEnabled: () => true,
    resolveInboxMaxBytes: () => CAP,
    scopeRank: () => 0,
  });
  server = await serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) return jsonResponse({ code: "not_found" }, 404);
      try {
        return await route.handler({ request, url, params: route.params } as unknown as RequestContext);
      } catch (error) {
        if (error instanceof ApiError) return jsonResponse(formatError(error), error.status);
        return jsonResponse({ code: "internal_error" }, 500);
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await rm(join(root, INBOX), { recursive: true, force: true });
});

afterAll(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe("workspace inbox uploads", () => {
  test("streams a raw body into the inbox", async () => {
    const bytes = new Uint8Array(CAP).fill(7);
    const response = await fetch(inboxUrl("chat-attachments/s1/a-video.mp4"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new File([bytes], "video.mp4"),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: "chat-attachments/s1/a-video.mp4", bytes: CAP });
    expect(new Uint8Array(await readFile(join(root, INBOX, "chat-attachments/s1/a-video.mp4")))).toEqual(bytes);
    expect((await inboxEntries()).filter((entry) => entry.includes(".upload-"))).toEqual([]);
  });

  test("stops a streamed body at the limit when fetch sends it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CAP));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const response = await fetch(inboxUrl("chunked-fetch.mp4"), { method: "POST", body, duplex: "half" } as RequestInit);

    expect(response.status).toBe(413);
    expect((await response.json() as { code: string }).code).toBe("file_too_large");
    expect(await inboxEntries()).toEqual([]);
  });

  test("refuses a declared size over the limit without touching the disk", async () => {
    const response = await fetch(inboxUrl("too-big.mp4"), { method: "POST", body: new File([new Uint8Array(CAP + 1)], "too-big.mp4") });

    expect(response.status).toBe(413);
    expect((await response.json() as { code: string }).code).toBe("file_too_large");
    expect(await inboxEntries()).toEqual([]);
  });

  test("stops an undeclared stream at the limit and leaves nothing behind", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(inboxUrl("chunked.mp4"), { method: "POST" }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.write(Buffer.alloc(CAP));
      request.end(Buffer.alloc(1));
    });

    expect(status).toBe(413);
    expect(await inboxEntries()).toEqual([]);
  });

  test("removes the partial file when the client disconnects", async () => {
    await new Promise<void>((resolve) => {
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write(`POST /workspace/w1/inbox?path=abandoned.mp4 HTTP/1.1\r\nHost: x\r\nContent-Length: ${CAP}\r\n\r\n`);
        socket.write(Buffer.alloc(16));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
    });

    for (let attempt = 0; attempt < 200 && (await inboxEntries()).some((entry) => entry.includes(".upload-")); attempt += 1) {
      await Bun.sleep(10);
    }
    expect((await inboxEntries()).filter((entry) => entry.includes(".upload-") || entry.includes("abandoned"))).toEqual([]);
  });

  test("requires a path for a raw upload", async () => {
    const response = await fetch(inboxUrl(), { method: "POST", body: new File(["x"], "x.mp4") });

    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("path_required");
  });

  test("still accepts multipart from older clients", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt"));
    form.append("path", "chat-attachments/s1/a-note.txt");
    const response = await fetch(inboxUrl(), { method: "POST", body: form });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: "chat-attachments/s1/a-note.txt", bytes: 5 });
    expect(await readFile(join(root, INBOX, "chat-attachments/s1/a-note.txt"), "utf8")).toBe("hello");
  });
});
