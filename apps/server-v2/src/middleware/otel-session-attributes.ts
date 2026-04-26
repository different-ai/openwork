import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../context/request-context.js";
import { getTraceApi } from "./otel-api.js";

/**
 * Enriches the active span with workspace and session IDs on
 * session routes. Lets you filter traces by workspace or session
 * in Jaeger/Grafana.
 */
export const otelSessionAttributesMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const api = await getTraceApi();
  if (!api) {
    await next();
    return;
  }

  const span = api.trace.getActiveSpan();
  if (!span) {
    await next();
    return;
  }

  const workspaceId = c.req.param("workspaceId");
  const sessionId = c.req.param("sessionId");

  if (workspaceId) {
    span.setAttribute("openwork.workspace_id", workspaceId);
  }
  if (sessionId) {
    span.setAttribute("openwork.session_id", sessionId);
  }

  await next();
};
