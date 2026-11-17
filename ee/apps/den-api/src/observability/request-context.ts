import { AsyncLocalStorage } from "node:async_hooks"
import type { MiddlewareHandler } from "hono"

const requestContext = new AsyncLocalStorage<string>()

export function currentRequestId() {
  return requestContext.getStore()
}

export function createRequestContextMiddleware(): MiddlewareHandler {
  return (c, next) => requestContext.run(c.get("requestId"), next)
}
