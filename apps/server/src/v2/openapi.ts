import { resolver } from "hono-openapi";
import { z } from "zod";

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
    .filter((part) => part !== "v2")
    .map((part) => {
      if (part.startsWith(":")) {
        return `by-${part.slice(1)}`;
      }

      if (part === "*") {
        return "wildcard";
      }

      return part;
    });

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

export function emptyResponse(description: string) {
  return { description };
}
