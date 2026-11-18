import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { managedInstallerApprovalInputSchema, managedInstallerErrorSchema, managedInstallerLatestSchema, managedInstallerPinInputSchema, managedInstallerProviderSchema, managedInstallerReportSchema, managedInstallerResetInputSchema, managedInstallerSourceInputSchema, managedInstallerValidationInputSchema, managedInstallerValidationSchema } from "@openwork/types/den/managed-installer-releases"
import { adminRoute, jsonValidator, paramValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { installerReleaseReport, pinInstallerRelease, resetInstallerRelease, saveInstallerApproval, saveInstallerSource, validateInstallerRelease } from "../../managed-deployments/releases.js"
import { latestInstallerVersion, InstallerReleaseError } from "../../managed-deployments/release-verifier.js"

const path = "/v1/admin/managed-releases"
const describe = (summary: string, schema: z.ZodType) => {
  const options: DescribeRouteOptions & { "x-mcp": boolean } = { tags: ["Admin"], summary, "x-mcp": false, responses: { 200: jsonResponse(summary, schema), ...Object.fromEntries([400, 401, 403, 409, 502, 503].map((status) => [status, jsonResponse("Release settings request failed.", managedInstallerErrorSchema)])) } }
  return describeRoute(options)
}
async function result<T>(run: () => Promise<T>): Promise<{ value: T, error?: never } | { value?: never, error: InstallerReleaseError }> {
  try { return { value: await run() } } catch (error) {
    return { error: error instanceof InstallerReleaseError ? error : new InstallerReleaseError("settings_unavailable", "Release settings are unavailable. Check the database migration and try again.", 503) }
  }
}

export function registerAdminManagedReleaseRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(path, describe("Read managed installer release settings and change history", managedInstallerReportSchema), adminRoute(), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const response = await result(() => installerReleaseReport(user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.get(`${path}/latest`, describe("Find the latest published stable OpenWork version", managedInstallerLatestSchema), adminRoute(), async (c) => {
    const response = await result(() => latestInstallerVersion())
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.put(`${path}/:provider/source`, describe("Save a public managed installer source", managedInstallerReportSchema), adminRoute(), paramValidator(z.object({ provider: managedInstallerProviderSchema })), jsonValidator(managedInstallerSourceInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const body = c.req.valid("json")
    const response = await result(() => saveInstallerSource(c.req.valid("param").provider, body.sourceBaseUrl, body.expectedRevision, user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.put(`${path}/:provider/approval`, describe("Configure managed installer approval policy", managedInstallerReportSchema), adminRoute(), paramValidator(z.object({ provider: managedInstallerProviderSchema })), jsonValidator(managedInstallerApprovalInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const body = c.req.valid("json")
    const response = await result(() => saveInstallerApproval(c.req.valid("param").provider, body.approvalMode, body.expectedRevision, user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.post(`${path}/validate`, describe("Verify an immutable published installer candidate", managedInstallerValidationSchema), adminRoute(), jsonValidator(managedInstallerValidationInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const response = await result(() => validateInstallerRelease(c.req.valid("json"), user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.post(`${path}/pin`, describe("Pin a verified installer after operator qualification attestation", managedInstallerReportSchema), adminRoute(), jsonValidator(managedInstallerPinInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const response = await result(() => pinInstallerRelease(c.req.valid("json"), user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.post(`${path}/reset`, describe("Explicitly restore environment installer defaults", managedInstallerReportSchema), adminRoute(), jsonValidator(managedInstallerResetInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const body = c.req.valid("json")
    const response = await result(() => resetInstallerRelease(body.provider, body.expectedRevision, user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
}
