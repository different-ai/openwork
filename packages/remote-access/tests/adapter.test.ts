import { test, expect } from "vitest";
import { createServer } from "node:http";
const api = (await import("../src/adapters/openwork-v2-01857.js").catch(
  () => ({}),
)) as any;
test("adapter rejects remote upstream endpoints before any credential can be sent", () => {
  expect(api.OpenWorkV2).toBeTypeOf("function");
  expect(
    () =>
      new api.OpenWorkV2(async () => ({
        origin: "https://example.com",
        token: "synthetic",
      })),
  ).not.toThrow();
  return expect(
    new api.OpenWorkV2(async () => ({
      origin: "https://example.com",
      token: "synthetic",
    })).health(),
  ).rejects.toThrow("UPSTREAM_UNAVAILABLE");
});
test("workspace normalization discards credentials and paths, unknown version disables writes", async () => {
  expect(api.OpenWorkV2).toBeTypeOf("function");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? { ok: true, version: "9.9.9" }
          : {
              items: [
                {
                  id: "ws_test",
                  name: "Work",
                  path: "/private",
                  opencode: { password: "secret" },
                },
              ],
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => ({
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      token: "synthetic",
    }));
    await a.health();
    expect(a.capabilities.sendText).toBe(false);
    expect(await a.listWorkspaces()).toEqual([{ id: "ws_test", name: "Work" }]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("paged messages are chronological and transport reloads a rejected read once", async () => {
  let discoveries = 0;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === "Bearer old") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        data: [
          {
            id: "msg_2",
            type: "assistant",
            time: { created: 2 },
            content: [{ type: "text", text: "Two" }],
            finish: "stop",
          },
          {
            id: "msg_1",
            type: "user",
            time: { created: 1 },
            content: [{ type: "text", text: "One" }],
          },
        ],
        cursor: { next: "older", previous: null },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => ({
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      token: ++discoveries === 1 ? "old" : "new",
    }));
    const page = await a.readMessages("ws_test", "ses_test");
    expect(page.data.map((m: any) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(page.cursor).toBe("older");
    expect(discoveries).toBe(2);
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("an embedded adapter only enables writes for the server version supplied by its own desktop build", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, version: "0.0.0-dev" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const discover = async () => ({
      origin: `http://127.0.0.1:${address.port}`,
      token: "synthetic",
    });
    const matched = new api.OpenWorkV2(discover, true, "0.0.0-dev");
    const mismatch = new api.OpenWorkV2(discover, true, "0.0.0-other");
    const standalone = new api.OpenWorkV2(discover);
    await Promise.all([
      matched.health(),
      mismatch.health(),
      standalone.health(),
    ]);
    expect(matched.capabilities.sendText).toBe(true);
    expect(mismatch.capabilities.sendText).toBe(false);
    expect(standalone.capabilities.sendText).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("native user text is retained when OpenWork does not provide a content array", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "msg_user",
            type: "user",
            time: { created: 1 },
            text: "A real user message",
          },
        ],
        cursor: { next: null, previous: null },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => ({
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      token: "synthetic",
    }));
    expect(
      (await a.readMessages("ws_test", "ses_test")).data[0].blocks,
    ).toEqual([{ kind: "text", text: "A real user message" }]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("a failed read rediscovers a restarted desktop once and normalizes terminal cursors", async () => {
  let discoveries = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [], cursor: { next: "", previous: "" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => ({
      origin:
        ++discoveries === 1
          ? "http://127.0.0.1:1"
          : "http://127.0.0.1:" + (server.address() as any).port,
      token: "synthetic",
    }));
    expect((await a.listSessions("ws_test")).cursor).toBeNull();
    expect((await a.readMessages("ws_test", "ses_test")).cursor).toBeNull();
    expect(discoveries).toBe(2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("provider failure is an error status and historical failures clear after a successful answer", async () => {
  let recovered = false;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const messages = [
      {
        id: "msg_failed",
        type: "assistant",
        time: { created: 1 },
        finish: "error",
        error: { type: "provider.auth", message: "private detail" },
        content: [],
      },
      ...(recovered
        ? [
            {
              id: "msg_ok",
              type: "assistant",
              time: { created: 2 },
              finish: "stop",
              content: [],
            },
          ]
        : []),
    ];
    res.end(
      JSON.stringify(
        req.url?.includes("/message?")
          ? { data: messages.reverse(), cursor: { next: "" } }
          : req.url?.endsWith("/active")
            ? { data: {} }
            : req.url?.endsWith("/permission")
              ? { data: [] }
              : {
                  data: {
                    id: "ses_test",
                    time: { created: 0 },
                    model: { providerID: "opencode", id: "synthetic" },
                  },
                },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => ({
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      token: "synthetic",
    }));
    expect(await a.readStatus("ws_test", "ses_test")).toMatchObject({
      phase: "error",
      errorCode: "MODEL_ERROR",
    });
    recovered = true;
    expect(await a.readStatus("ws_test", "ses_test")).toMatchObject({
      phase: "idle",
      errorCode: null,
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("intentional interruption normalizes to cancelled and leaves the chat idle", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.includes("/message?")
          ? {
              data: [
                {
                  id: "msg_stopped",
                  type: "assistant",
                  time: { created: 1 },
                  finish: "error",
                  error: { type: "aborted" },
                  content: [],
                },
              ],
              cursor: { next: "" },
            }
          : req.url?.endsWith("/active")
            ? { data: {} }
            : req.url?.endsWith("/permission")
              ? { data: [] }
              : { data: { id: "ses_test", time: { created: 0 } } },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => ({
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      token: "synthetic",
    }));
    expect((await a.readMessages("ws_test", "ses_test")).data[0].state).toBe(
      "cancelled",
    );
    expect(await a.readStatus("ws_test", "ses_test")).toMatchObject({
      phase: "idle",
      errorCode: null,
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("send registers the unchanged session model before prompting, including its variant", async () => {
  const posts: { route: string; body: unknown }[] = [];
  const model = { providerID: "openwork-free", id: "auto", variant: "high" };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      posts.push({ route: req.url ?? "", body: JSON.parse(body) });
      res.end(
        JSON.stringify({ data: { id: "msg_admitted", sessionID: "ses_test" } }),
      );
      return;
    }
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? { ok: true, version: "0.18.57" }
          : { data: { id: "ses_test", model, time: { created: 0 } } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const adapter = new api.OpenWorkV2(async () => ({
      origin: `http://127.0.0.1:${address.port}`,
      token: "synthetic",
    }));
    await adapter.health();
    await adapter.send("ws_test", "ses_test", "Synthetic");
    expect(posts).toEqual([
      {
        route: "/workspace/ws_test/opencode2/api/session/ses_test/model",
        body: { model },
      },
      {
        route: "/workspace/ws_test/opencode2/api/session/ses_test/prompt",
        body: { text: "Synthetic" },
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("a lost mutation response is never retried or rediscovered", async () => {
  let posts = 0,
    discoveries = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      posts++;
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? { ok: true, version: "0.18.57" }
          : {
              data: {
                id: "ses_test",
                model: { providerID: "test", id: "model" },
                time: { created: 0 },
              },
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new api.OpenWorkV2(async () => {
      discoveries++;
      return {
        origin: "http://127.0.0.1:" + (server.address() as any).port,
        token: "synthetic",
      };
    });
    await a.health();
    await expect(a.send("ws_test", "ses_test", "Synthetic")).rejects.toThrow(
      "UPSTREAM_UNAVAILABLE",
    );
    expect(posts).toBe(1);
    expect(discoveries).toBe(1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test.each([
  [
    { enabled: false, chatRouting: false, running: false },
    "ENGINE_V2_REQUIRED",
  ],
  [{ enabled: true, chatRouting: false, running: true }, "ENGINE_V2_REQUIRED"],
  [
    { enabled: true, chatRouting: true, running: false },
    "UPSTREAM_UNAVAILABLE",
  ],
  [{ enabled: true, chatRouting: true, running: true }, null],
])(
  "embedded readiness checks the existing engine without changing it: %j",
  async (status, error) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(status));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      const adapter = new api.OpenWorkV2(async () => ({
        origin: `http://127.0.0.1:${address.port}`,
        token: "synthetic",
      }));
      if (error)
        await expect(adapter.requireChatEngine()).rejects.toThrow(error);
      else await expect(adapter.requireChatEngine()).resolves.toBeUndefined();
      expect(requests).toEqual(["GET /experimental/engine-v2-preview/status"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
