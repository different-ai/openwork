import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { harnessFeedbackOrganizationIds, isHarnessFeedbackOrganization } from "../../harness-feedback/access.js"
import { listHarnessFeedback, readHarnessFeedbackGroup, readUngroupedHarnessFeedbackReport } from "../../harness-feedback/repository.js"
import { adminRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

export function registerAdminHarnessFeedbackRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const path = "/v1/admin/harness-feedback"
  const headers = { "cache-control": "no-store" }

  app.get(path, adminRoute(), async (c) => {
    return c.json(await listHarnessFeedback(harnessFeedbackOrganizationIds()), 200, headers)
  })

  app.get(`${path}/reports/:organizationId/:reportId`, adminRoute(), async (c) => {
    const { organizationId, reportId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Ungrouped feedback report not found." }, 404, headers)
    if (!isHarnessFeedbackOrganization(organizationId) || !isDenTypeId("harnessFeedbackReport", reportId)) return notFound()
    const detail = await readUngroupedHarnessFeedbackReport(organizationId, reportId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })

  app.get(`${path}/:organizationId/:groupId`, adminRoute(), async (c) => {
    const { organizationId, groupId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Feedback group not found." }, 404, headers)
    if (!isHarnessFeedbackOrganization(organizationId) || !isDenTypeId("harnessFeedbackGroup", groupId)) return notFound()
    const detail = await readHarnessFeedbackGroup(organizationId, groupId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })
}
