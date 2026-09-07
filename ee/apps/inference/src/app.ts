import "./load-env.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@openwork-ee/den-db/drizzle";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./env.js";
import { inferenceAccessLogger, sentryInferenceReporter } from "./inference-reporting.js";
import { registerProxyRoutes } from "./proxy.js";
import { registerRollupRoutes, runRollups } from "./rollups.js";
import { registerWebhookRoutes } from "./webhooks.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const modelsApiJsonPath = path.resolve(srcDir, "..", "models-site", "models", "api.json");
const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL);
const shouldServeLocalModelCatalog = !isVercelRuntime && (process.env.NODE_ENV !== "production" || process.env.OPENWORK_DEV_MODE === "1");

const app = new Hono();

function healthPath(path: string) {
  return path === "/health" || path === "/ready";
}

app.use("*", async (c, next) => {
  if (healthPath(c.req.path)) {
    await next();
    return;
  }

  return inferenceAccessLogger(c, next);
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
        "X-Goog-Api-Key",
        "Api-Key",
        "X-Webhook-Signature",
        "X-Test-Connection",
        "X-Openwork-Session-Id",
        "X-Openwork-Task-Id",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["X-OpenWork-Request-Id", "Retry-After"],
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
    console.error("[readiness] inference database check failed");
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
registerWebhookRoutes(app);
registerRollupRoutes(app, { adminToken: env.adminToken, runRollups });

app.onError((error, c) => {
  if (error instanceof z.ZodError) {
    return c.json({ error: "invalid_request" }, 400);
  }
  console.error("[inference] internal_server_error");
  sentryInferenceReporter.handledError({ reason: "internal_server_error", route: "/api/v1/*", method: c.req.method, status: 500 });
  return c.json({ error: "internal_server_error" }, 500);
});

export default app;
