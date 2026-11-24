import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { env } from "../../env.js"
import { listHarnessFeedback, readHarnessFeedbackGroup } from "../../harness-feedback/repository.js"
import { adminRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

export function registerAdminHarnessFeedbackRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const path = "/v1/admin/harness-feedback"
  const headers = { "cache-control": "no-store" }

  app.get(path, adminRoute(), async (c) => {
    const ids = [...env.harnessFeedbackOrgIds].filter((id) => isDenTypeId("organization", id))
    return c.json(await listHarnessFeedback(ids), 200, headers)
  })

  app.get(`${path}/:organizationId/:groupId`, adminRoute(), async (c) => {
    const { organizationId, groupId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Feedback group not found." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !env.harnessFeedbackOrgIds.has(organizationId)
      || !isDenTypeId("harnessFeedbackGroup", groupId)) return notFound()
    const detail = await readHarnessFeedbackGroup(organizationId, groupId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })
}
