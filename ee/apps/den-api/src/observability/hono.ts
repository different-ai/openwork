import type { Context, Env, Hono, MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppLogger } from "./logger.js"
import { appLogger } from "./logger.js"
import { normalizedHonoRoute } from "./hono-route.js"
import { attachRequestContext, getRuntimeState } from "./runtime.js"
import { sanitizeExceptionForTelemetry, sanitizeText } from "./safe-fields.js"

export function statusFromError(error: unknown) {
  if (error instanceof HTTPException) {
    return error.status
  }

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number(error.status)
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status
    }
  }

  return 500
}

function healthPath(path: string) {
  return path === "/health" || path === "/ready"
}

export function registerObservabilityMiddleware<E extends Env>(app: Hono<E>) {
  const state = getRuntimeState()
  if (state.honoMiddlewareFactory) {
    app.use("*", state.honoMiddlewareFactory(app))
  }
  for (const middleware of state.honoMiddlewares) {
    app.use("*", middleware)
  }
}

export function createRequestAccessLogMiddleware(logger: AppLogger = appLogger.child({ component: "http" })): MiddlewareHandler {
  return async (c, next) => {
    if (healthPath(c.req.path)) {
      await next()
      return
    }

    const startedAt = performance.now()
    let thrownError: unknown
    const requestId = c.get("requestId")

    attachRequestContext({
      request_id: typeof requestId === "string" ? requestId : undefined,
    })

    try {
      await next()
    } catch (error) {
      thrownError = error
      throw error
    } finally {
      const route = normalizedHonoRoute(c)
      const status = thrownError === undefined ? c.res.status : statusFromError(thrownError)
      attachRequestContext({
        request_id: typeof requestId === "string" ? requestId : undefined,
        http_route: route,
        http_status_code: status,
      })
      logger.info("request completed", {
        request_id: typeof requestId === "string" ? requestId : undefined,
        http_method: c.req.method,
        http_route: route,
        http_status_code: status,
        duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      })
    }
  }
}

function sanitizeRequestError(error: unknown) {
  if (error instanceof HTTPException) {
    return new HTTPException(error.status, {
      message: sanitizeText(error.message),
      res: error.res,
    })
  }

  return sanitizeExceptionForTelemetry(error)
}

export function createTelemetryErrorSanitizerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next()
      if (c.error) {
        c.error = sanitizeRequestError(c.error)
      }
    } catch (error) {
      throw sanitizeRequestError(error)
    }
  }
}

type ErrorResponseFactory<E extends Env> = (error: Error, c: Context<E>, requestId: string) => Response | undefined

export function registerAppErrorHandler<E extends Env>(app: Hono<E>, responseForError?: ErrorResponseFactory<E>) {
  const logger = appLogger.child({ component: "http" })

  app.onError((error, c) => {
    const safeError = sanitizeRequestError(error)
    const status = statusFromError(safeError)
    const requestId = c.get("requestId")
    const fields = {
      request_id: typeof requestId === "string" ? requestId : undefined,
      http_method: c.req.method,
      http_route: normalizedHonoRoute(c),
      http_status_code: status,
      error: safeError,
    }

    if (status >= 500) {
      logger.error("request failed", fields)
    } else {
      logger.warn("request rejected", fields)
    }

    const customResponse = responseForError?.(safeError, c, requestId)
    if (customResponse) {
      return customResponse
    }

    if (safeError instanceof HTTPException) {
      return safeError.getResponse()
    }

    return c.json({ error: "internal_server_error" }, 500)
  })
}
