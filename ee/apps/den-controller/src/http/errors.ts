import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express"

const TRANSIENT_DB_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }

  if (typeof error.code === "string") {
    return error.code
  }

  return getErrorCode(error.cause)
}

export function isTransientDbConnectionError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) {
    return false
  }
  return TRANSIENT_DB_ERROR_CODES.has(code)
}

export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next)
  }
}

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    return
  }

  if (isTransientDbConnectionError(error)) {
    const message = error instanceof Error ? error.message : "transient database connection failure"
    console.warn(`[http] transient db connection error: ${message}`)
    res.status(503).json({
      error: "service_unavailable",
      message: "Database connection was interrupted. Please retry.",
    })
    return
  }

  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[http] unhandled error: ${message}`)
  res.status(500).json({ error: "internal_error" })
}
