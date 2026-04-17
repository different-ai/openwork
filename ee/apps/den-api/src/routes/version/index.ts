import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { jsonResponse } from "../../openapi.js"
import { denApiAppVersion } from "../../version.js"

const appVersionResponseSchema = z.object({
  minAppVersion: z.string(),
  latestAppVersion: z.string().min(1),
}).meta({ ref: "DenAppVersionResponse" })

export function registerVersionRoutes<T extends Env>(app: Hono<T>) {
  app.get(
    "/v1/app-version",
    describeRoute({
      tags: ["System"],
      summary: "Get desktop app version metadata",
      description: "Returns the minimum supported desktop app version and the latest desktop app version published with this Den API build.",
      responses: {
        200: jsonResponse("Desktop app version metadata returned successfully.", appVersionResponseSchema),
      },
    }),
    (c) => {
      return c.json(denApiAppVersion)
    },
  )
}
