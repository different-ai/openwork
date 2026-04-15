import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../context/request-context.js";

export const requestLoggerMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const startedAt = performance.now();

  await next();

  const durationMs = Number((performance.now() - startedAt).toFixed(1));
  const url = new URL(c.req.url);

  console.info(
    JSON.stringify({
      durationMs,
      method: c.req.method,
      path: url.pathname,
      requestId: c.get("requestId"),
      scope: "openwork-server-v2.request",
      status: c.res.status,
    }),
  );
};
