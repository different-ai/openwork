import type { Hono } from "hono"
import { OPENWORK_CODE_HELPER_SOURCE } from "../../cloud-coding/helper/openwork-code-source.js"
import { publicRoute } from "../../middleware/route-access.js"

export function registerCloudCodingHelperRoute<T extends { Variables: object }>(app: Hono<T>) {
  app.get("/v1/cloud-coding/gateway/helper.mjs", publicRoute, (c) => c.body(OPENWORK_CODE_HELPER_SOURCE, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  }))
}
