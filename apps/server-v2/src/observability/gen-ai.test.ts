import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppBindings } from "../context/request-context.js";
import { resetOtelApiCacheForTesting } from "./api.js";
import { recordPromptAttributes } from "./gen-ai.js";

afterEach(() => {
  resetOtelApiCacheForTesting();
});

function createTestApp() {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("requestId", "test-req-id");
    await next();
  });
  return app;
}

test("recordPromptAttributes is a no-op when no span is active", async () => {
  const app = createTestApp();
  app.post("/chat", async (c) => {
    await recordPromptAttributes(c, {
      operation: "chat",
      workspaceId: "ws_1",
      sessionId: "ses_1",
      body: { model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" } },
    });
    return c.text("ok");
  });
  const res = await app.request("/chat", { method: "POST" });
  expect(res.status).toBe(200);
});

test("recordPromptAttributes tolerates a missing body", async () => {
  const app = createTestApp();
  app.post("/shell", async (c) => {
    await recordPromptAttributes(c, {
      operation: "shell",
      workspaceId: "ws_1",
      sessionId: "ses_1",
    });
    return c.text("ok");
  });
  const res = await app.request("/shell", { method: "POST" });
  expect(res.status).toBe(200);
});
