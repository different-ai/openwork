import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppBindings } from "../context/request-context.js";
import { getTraceApi } from "./otel-api.js";

const TRACER_NAME = "openwork-server-v2";

export const otelTracingMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const api = await getTraceApi();
  if (!api) {
    await next();
    return;
  }

  const tracer = api.trace.getTracer(TRACER_NAME);
  const initialName = `${c.req.method} ${c.req.path}`;

  await tracer.startActiveSpan(initialName, async (span) => {
    try {
      const requestId = c.get("requestId");

      span.setAttribute("http.request.method", c.req.method);
      span.setAttribute("url.path", c.req.path);

      if (requestId) {
        span.setAttribute("http.request_id", requestId);
      }

      await next();

      const matched = routePath(c);
      if (matched) {
        span.updateName(`${c.req.method} ${matched}`);
        span.setAttribute("http.route", matched);
      }

      span.setAttribute("http.response.status_code", c.res.status);

      if (c.res.status >= 500) {
        span.setStatus({ code: api.SpanStatusCode.ERROR });
      }
    } catch (err) {
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : "unknown error",
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
};
