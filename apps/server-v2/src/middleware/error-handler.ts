import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { buildErrorResponse } from "../http.js";
import type { AppBindings } from "../context/request-context.js";

export const errorHandlingMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  try {
    await next();
  } catch (error) {
    const requestId = c.get("requestId") ?? `owreq_${crypto.randomUUID()}`;

    if (error instanceof HTTPException) {
      const status = error.status;
      const code = status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : "invalid_request";
      const body = buildErrorResponse({
        requestId,
        code,
        message: error.message || (code === "not_found" ? "Route not found." : "Request failed."),
      });
      return c.json(body, status);
    }

    if (error instanceof ZodError) {
      const body = buildErrorResponse({
        requestId,
        code: "invalid_request",
        message: "Request validation failed.",
        details: error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number"),
        })),
      });
      return c.json(body, 400);
    }

    const message = error instanceof Error ? error.message : "Unexpected server error.";

    console.error(
      JSON.stringify({
        message,
        requestId,
        scope: "openwork-server-v2.error",
      }),
    );

    return c.json(
      buildErrorResponse({
        requestId,
        code: "internal_error",
        message: "Unexpected server error.",
      }),
      500,
    );
  }
};
