import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../context/request-context.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

export const responseFinalizerMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();

  const requestId = c.get("requestId");
  if (requestId) {
    c.header(REQUEST_ID_HEADER, requestId);
  }

  if (!c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "no-store");
  }
};
