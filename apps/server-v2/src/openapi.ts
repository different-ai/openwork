import { resolver } from "hono-openapi";
import type { z } from "zod";
import {
  forbiddenErrorSchema,
  internalErrorSchema,
  invalidRequestErrorSchema,
  notFoundErrorSchema,
  unauthorizedErrorSchema,
} from "./schemas/errors.js";

function toPascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function buildOperationId(method: string, path: string) {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith(":")) {
        return `by-${part.slice(1)}`;
      }

      if (part === "*") {
        return "wildcard";
      }

      return part;
    });

  if (parts.length === 0) {
    return `${method.toLowerCase()}Root`;
  }

  return [method.toLowerCase(), ...parts]
    .map(toPascalCase)
    .join("")
    .replace(/^[A-Z]/, (char) => char.toLowerCase());
}

export function jsonResponse(description: string, schema: z.ZodTypeAny) {
  return {
    description,
    content: {
      "application/json": {
        schema: resolver(schema),
      },
    },
  };
}

export function withCommonErrorResponses<TResponses extends Record<number, unknown>>(
  responses: TResponses,
  options: {
    includeForbidden?: boolean;
    includeNotFound?: boolean;
    includeInvalidRequest?: boolean;
    includeUnauthorized?: boolean;
  } = {},
) {
  return {
    ...responses,
    ...(options.includeInvalidRequest
      ? {
          400: jsonResponse("Request validation failed.", invalidRequestErrorSchema),
        }
      : {}),
    ...(options.includeUnauthorized
      ? {
          401: jsonResponse("Authentication is required for this route.", unauthorizedErrorSchema),
        }
      : {}),
    ...(options.includeForbidden
      ? {
          403: jsonResponse("The authenticated actor does not have access to this route.", forbiddenErrorSchema),
        }
      : {}),
    ...(options.includeNotFound
      ? {
          404: jsonResponse("The requested route was not found.", notFoundErrorSchema),
        }
      : {}),
    500: jsonResponse("The server failed to complete the request.", internalErrorSchema),
  };
}
