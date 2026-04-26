import type { MiddlewareHandler } from "hono";
import { routePath as resolveRoutePath } from "hono/route";
import type { AppBindings } from "../context/request-context.js";
import { getOtelApi } from "../observability/api.js";

const TRACER_NAME = "openwork-server-v2";

export const observabilityTracingMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const api = await getOtelApi();
  if (!api) {
    await next();
    return;
  }

  const tracer = api.trace.getTracer(TRACER_NAME);
  const initialName = `${c.req.method} ${c.req.path}`;

  await tracer.startActiveSpan(initialName, async (span) => {
    try {
      span.setAttribute("http.request.method", c.req.method);
      span.setAttribute("url.path", c.req.path);

      const requestId = c.get("requestId");
      if (requestId) span.setAttribute("openwork.request_id", requestId);

      await next();

      const matchedRoute = resolveRoutePath(c);
      if (matchedRoute) {
        span.updateName(`${c.req.method} ${matchedRoute}`);
        span.setAttribute("http.route", matchedRoute);
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
