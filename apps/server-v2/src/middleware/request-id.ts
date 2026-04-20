import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../context/request-context.js";

export const REQUEST_ID_HEADER = "X-Request-Id";

function normalizeIncomingRequestId(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, 200);
}

export const requestIdMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const requestId = normalizeIncomingRequestId(c.req.header(REQUEST_ID_HEADER)) ?? `owreq_${crypto.randomUUID()}`;
  c.set("requestId", requestId);
  await next();
};
