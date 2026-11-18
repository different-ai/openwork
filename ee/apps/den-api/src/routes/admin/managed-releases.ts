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
const describe = (summary: string, description: string, schema: z.ZodType) => {
  const options: DescribeRouteOptions & { "x-mcp": boolean } = { tags: ["Admin"], summary, description, "x-mcp": false, responses: { 200: jsonResponse(summary, schema), ...Object.fromEntries([400, 401, 403, 409, 502, 503].map((status) => [status, jsonResponse("Release settings request failed.", managedInstallerErrorSchema)])) } }
  return describeRoute(options)
}
async function result<T>(run: () => Promise<T>): Promise<{ value: T, error?: never } | { value?: never, error: InstallerReleaseError }> {
  try { return { value: await run() } } catch (error) {
    return { error: error instanceof InstallerReleaseError ? error : new InstallerReleaseError("settings_unavailable", "Release settings are unavailable. Check the database migration and try again.", 503) }
  }
}

export function registerAdminManagedReleaseRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(path, describe("Read managed installer release settings and change history", "Returns each provider's effective installer default, published release source, approval policy, current verification and recent attributed changes. Platform administrators only; does not fetch artifacts or change existing installations or approvals.", managedInstallerReportSchema), adminRoute(), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const response = await result(() => installerReleaseReport(user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.get(`${path}/latest`, describe("Find the latest published stable OpenWork version", "Reads the official GitHub latest-release metadata and returns an exact stable version and release link. Platform administrators only; this is a version suggestion, not publication, cloud qualification or a change to the managed default.", managedInstallerLatestSchema), adminRoute(), async (c) => {
    const response = await result(() => latestInstallerVersion())
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.put(`${path}/:provider/source`, describe("Save a public managed installer source", "Saves a provider-specific public S3 or Google Cloud Storage release folder using the expected configuration revision. Platform administrators only; records the actor, invalidates older previews and leaves the current installer pin and existing runs unchanged.", managedInstallerReportSchema), adminRoute(), paramValidator(z.object({ provider: managedInstallerProviderSchema })), jsonValidator(managedInstallerSourceInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const body = c.req.valid("json")
    const response = await result(() => saveInstallerSource(c.req.valid("param").provider, body.sourceBaseUrl, body.expectedRevision, user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.put(`${path}/:provider/approval`, describe("Configure managed installer approval policy", "Sets whether pinning requires an administrator other than the verifier or permits one platform administrator to verify and pin. Platform administrators only; checks the expected revision, records the policy change and invalidates previews without changing any installed deployment.", managedInstallerReportSchema), adminRoute(), paramValidator(z.object({ provider: managedInstallerProviderSchema })), jsonValidator(managedInstallerApprovalInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const body = c.req.valid("json")
    const response = await result(() => saveInstallerApproval(c.req.valid("param").provider, body.approvalMode, body.expectedRevision, user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.post(`${path}/validate`, describe("Verify an immutable published installer candidate", "Reads the selected stable installer's manifest, template and bundle from the configured public source, verifies immutable object versions, checksums and complete runtime image inventory, and stores an expiring revision-bound preview. Platform administrators only; does not run a cloud install, attest qualification or change the default.", managedInstallerValidationSchema), adminRoute(), jsonValidator(managedInstallerValidationInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const response = await result(() => validateInstallerRelease(c.req.valid("json"), user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.post(`${path}/pin`, describe("Pin a verified installer after operator qualification attestation", "Rechecks the stored unexpired candidate and expected configuration revision, enforces the configured approval policy, and records fresh-install and approved-Update qualification references with the actor and manifest hash. Platform administrators only; changes new-install defaults and update availability, never existing resources or frozen approvals.", managedInstallerReportSchema), adminRoute(), jsonValidator(managedInstallerPinInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const response = await result(() => pinInstallerRelease(c.req.valid("json"), user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
  app.post(`${path}/reset`, describe("Explicitly restore environment installer defaults", "Clears the administrator-managed release pin and restores the existing environment-backed default using the expected revision. Platform administrators only; records the change, preserves source and approval policy, and never changes installed versions, cloud resources or active approvals.", managedInstallerReportSchema), adminRoute(), jsonValidator(managedInstallerResetInputSchema), async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized", message: "Sign in required." }, 401)
    const body = c.req.valid("json")
    const response = await result(() => resetInstallerRelease(body.provider, body.expectedRevision, user.id))
    return response.error ? c.json({ error: response.error.code, message: response.error.message }, response.error.status) : c.json(response.value)
  })
}
