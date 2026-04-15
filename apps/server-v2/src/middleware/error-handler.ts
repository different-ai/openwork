import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { buildErrorResponse, RouteError } from "../http.js";
import type { AppBindings } from "../context/request-context.js";

export const errorHandlingMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  try {
    await next();
  } catch (error) {
    const requestId = c.get("requestId") ?? `owreq_${crypto.randomUUID()}`;
    const routeLike = error && typeof error === "object"
      ? error as { code?: unknown; details?: unknown; message?: unknown; status?: unknown }
      : null;

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

    if (error instanceof RouteError) {
      return c.json(
        buildErrorResponse({
          requestId,
          code: error.code,
          message: error.message,
          details: error.details,
        }),
        error.status as any,
      );
    }

    if (
      routeLike
      && typeof routeLike.status === "number"
      && typeof routeLike.code === "string"
      && typeof routeLike.message === "string"
    ) {
      return c.json(
        buildErrorResponse({
          requestId,
          code: routeLike.code as any,
          message: routeLike.message,
          details: Array.isArray(routeLike.details) ? routeLike.details as any : undefined,
        }),
        routeLike.status as any,
      );
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
