import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppBindings } from "../context/request-context.js";
import { otelTracingMiddleware } from "./otel-tracing.js";

function createTestApp() {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("requestId", "test-req-id");
    await next();
  });

  app.use("*", otelTracingMiddleware);

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/workspaces/:workspaceId/sessions/:sessionId", (c) =>
    c.json({ ws: c.req.param("workspaceId"), session: c.req.param("sessionId") }),
  );

  return app;
}

test("passes through requests when otel is not configured", async () => {
  const app = createTestApp();
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("handles 404 without crashing", async () => {
  const app = createTestApp();
  const res = await app.request("/nonexistent");
  expect(res.status).toBe(404);
});

test("handles parameterized routes", async () => {
  const app = createTestApp();
  const res = await app.request("/workspaces/ws-123/sessions/sess-456");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ws).toBe("ws-123");
  expect(body.session).toBe("sess-456");
});

test("handles errors in downstream handlers", async () => {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("requestId", "test-req-id");
    await next();
  });
  app.use("*", otelTracingMiddleware);
  app.get("/boom", () => {
    throw new Error("test explosion");
  });

  const res = await app.request("/boom");
  expect(res.status).toBe(500);
});
