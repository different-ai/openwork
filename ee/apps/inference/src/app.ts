import "./load-env.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@openwork-ee/den-db/drizzle";
import { sentry } from "@sentry/hono/node";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./env.js";
import { isSentryEnabled } from "./instrumentation.js";
import { registerProxyRoutes } from "./proxy.js";
import { registerVoiceRoutes } from "./voice.js";
import { registerWebhookRoutes } from "./webhooks.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const modelsApiJsonPath = path.resolve(srcDir, "..", "models-site", "models", "api.json");
const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL);
const shouldServeLocalModelCatalog = !isVercelRuntime && (process.env.NODE_ENV !== "production" || process.env.OPENWORK_DEV_MODE === "1");

const app = new Hono();

if (isSentryEnabled) {
  app.use("*", sentry(app));
}

const requestLogger = logger((message, ...rest) => {
  if (/-->\s+\S+\s+\S+\s+[45]\d\d\b/.test(message)) {
    console.error(message, ...rest);
    return;
  }
  console.log(message, ...rest);
});

app.use("*", async (c, next) => {
  if (c.req.path === "/health" || c.req.path === "/ready") {
    await next();
    return;
  }

  return requestLogger(c, next);
});

if (env.corsOrigins.length > 0) {
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      credentials: true,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Api-Key",
        "X-Webhook-Signature",
        "X-Test-Connection",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );
}

app.get("/health", (c) => c.json({ ok: true, service: "inference" }));

app.get("/ready", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ ok: true, service: "inference", checks: { database: "ok" } });
  } catch (error) {
    console.error("[readiness] inference database check failed", error);
    return c.json({ ok: false, service: "inference", checks: { database: "error" } }, 503);
  }
});

if (shouldServeLocalModelCatalog) {
  app.get("/models/api.json", async (c) => {
    const body = await readFile(modelsApiJsonPath, "utf8");
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(body);
  });
}

registerProxyRoutes(app);
registerVoiceRoutes(app);
registerWebhookRoutes(app);

app.onError((error, c) => {
  if (error instanceof z.ZodError) {
    return c.json({ error: "invalid_request", issues: error.issues }, 400);
  }
  console.error(error);
  return c.json({ error: "internal_server_error" }, 500);
});

export default app;
