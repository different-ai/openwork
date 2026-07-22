import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { publicRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { PUBLISHED_DESKTOP_VERSIONS } from "../../generated/desktop-versions.js"
import { denApiAppVersion } from "../../version.js"

const appVersionResponseSchema = z.object({
  minAppVersion: z.string(),
  latestAppVersion: z.string().min(1),
  publishedDesktopVersions: z.array(z.string().min(1)),
}).meta({ ref: "DenAppVersionResponse" })

export function registerVersionRoutes<T extends Env>(app: Hono<T>) {
  app.get(
    "/v1/app-version",
    describeRoute({
      tags: ["System"],
      summary: "Get desktop app version metadata",
      description: "Returns the supported desktop app range and stable published desktop releases from GitHub.",
      responses: {
        200: jsonResponse("Desktop app version metadata returned successfully.", appVersionResponseSchema),
      },
    }),
    publicRoute,
    (c) => {
      c.header("Cache-Control", "public, max-age=300, stale-if-error=86400")
      return c.json({
        ...denApiAppVersion,
        publishedDesktopVersions: [...PUBLISHED_DESKTOP_VERSIONS],
      })
    },
  )
}
