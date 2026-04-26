import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppBindings } from "../context/request-context.js";
import { otelTracingMiddleware } from "./otel-tracing.js";
import { otelSessionAttributesMiddleware } from "./otel-session-attributes.js";

function createTestApp() {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("requestId", "test-req-id");
    await next();
  });
  app.use("*", otelTracingMiddleware);
  app.use("/workspaces/:workspaceId/sessions/*", otelSessionAttributesMiddleware);

  app.get("/workspaces/:workspaceId/sessions/:sessionId", (c) =>
    c.json({ ws: c.req.param("workspaceId"), session: c.req.param("sessionId") }),
  );
  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}

test("session attributes middleware passes through on session routes", async () => {
  const app = createTestApp();
  const res = await app.request("/workspaces/ws-1/sessions/sess-2");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ws).toBe("ws-1");
  expect(body.session).toBe("sess-2");
});

test("non-session routes work without session attributes middleware", async () => {
  const app = createTestApp();
  const res = await app.request("/health");
  expect(res.status).toBe(200);
});
