import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { sandboxCreatedSchema, sandboxCreateInputSchema, sandboxCreditInputSchema, sandboxExtendInputSchema, sandboxJoinRoleInputSchema, sandboxListSchema } from "@openwork/types/den/sandbox-organizations"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { env } from "../../env.js"
import { adminRoute, jsonValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { closeSandbox, createSandbox, extendSandbox, listSandboxes, rotateSandboxLink, SandboxInputError, sandboxDefaults, setSandboxCredit, setSandboxJoinRole } from "../../sandbox-organizations.js"
import type { AuthContextVariables } from "../../session.js"

const base = "/v1/admin/sandbox-orgs"
const errors = {
  400: jsonResponse("Invalid sandbox or request.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
  404: jsonResponse("Sandbox not found, or sandbox organizations are unavailable on this deployment.", notFoundSchema),
}
const disabled = { error: "not_found", message: "Sandbox organizations are only available on cloud deployments." } as const

export function registerAdminSandboxOrganizationRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(base, describeRoute({ tags: ["Admin"], summary: "List sandbox organizations", description: "Lists try-it-out organizations with their join link, members, connectors and when they end. Sandboxes whose time ran out are closed first. Platform administrators only.", responses: { 200: jsonResponse("Sandbox organizations.", sandboxListSchema), ...errors } }), adminRoute(), async c => {
    c.header("Cache-Control", "no-store")
    if (env.features.deployment !== "cloud") return c.json({ enabled: false, sandboxes: [] })
    return c.json({ enabled: true, sandboxes: await listSandboxes(), defaults: sandboxDefaults() })
  })

  app.post(base, describeRoute({ tags: ["Admin"], summary: "Create a sandbox organization", description: "Creates an organization owned by the calling admin on the Enterprise plan until the sandbox ends, with included models, AI Gateway models for everyone (the sandbox's own OpenRouter key capped at creditUsd when the deployment mints them), Free Auto until the sandbox closes or expires, one per-person OAuth connector for each fictional workplace app, and a join link that joins people as members until the sandbox ends. Platform administrators only.", responses: { 200: jsonResponse("Sandbox created.", sandboxCreatedSchema), ...errors } }), adminRoute(), jsonValidator(sandboxCreateInputSchema), async c => {
    if (env.features.deployment !== "cloud") return c.json(disabled, 404)
    try {
      const sandbox = await createSandbox(normalizeDenTypeId("user", c.get("user").id), c.req.valid("json"))
      return c.json({ sandbox })
    } catch (error) {
      if (error instanceof SandboxInputError) return c.json({ error: "invalid_request", message: error.message }, 400)
      throw error
    }
  })

  const updated = (summary: string, description: string) => describeRoute({ tags: ["Admin"], summary, description, responses: { 200: jsonResponse("Updated sandbox.", sandboxCreatedSchema), ...errors } })

  app.post(`${base}/:sandboxId/rotate-link`, updated("Replace a sandbox join link", "Issues a new join link; the old link stops working immediately. Existing members are unaffected. Platform administrators only."), adminRoute(), async c => {
    if (env.features.deployment !== "cloud") return c.json(disabled, 404)
    const id = c.req.param("sandboxId")
    if (!isDenTypeId("sandboxOrganization", id)) return c.json({ error: "invalid_request", message: "Invalid sandbox id." }, 400)
    const sandbox = await rotateSandboxLink(normalizeDenTypeId("sandboxOrganization", id))
    return sandbox ? c.json({ sandbox }) : c.json({ error: "not_found", message: "Sandbox not found." }, 404)
  })

  app.post(`${base}/:sandboxId/join-role`, updated("Choose what people who join become", "Sets whether people who join with the link from now on become members or admins. People who already joined keep their role; change it on the organization's Members page. Platform administrators only."), adminRoute(), jsonValidator(sandboxJoinRoleInputSchema), async c => {
    if (env.features.deployment !== "cloud") return c.json(disabled, 404)
    const id = c.req.param("sandboxId")
    if (!isDenTypeId("sandboxOrganization", id)) return c.json({ error: "invalid_request", message: "Invalid sandbox id." }, 400)
    const sandbox = await setSandboxJoinRole(normalizeDenTypeId("sandboxOrganization", id), c.req.valid("json").joinRole)
    return sandbox ? c.json({ sandbox }) : c.json({ error: "not_found", message: "Sandbox not found." }, 404)
  })

  app.post(`${base}/:sandboxId/extend`, updated("Extend or reopen a sandbox", "Adds days from now or from the current end, whichever is later, reopens the join link, turns included models, Free Auto and the sandbox's own model key back on, and moves the Enterprise plan's end date. Platform administrators only."), adminRoute(), jsonValidator(sandboxExtendInputSchema), async c => {
    if (env.features.deployment !== "cloud") return c.json(disabled, 404)
    const id = c.req.param("sandboxId")
    if (!isDenTypeId("sandboxOrganization", id)) return c.json({ error: "invalid_request", message: "Invalid sandbox id." }, 400)
    const sandbox = await extendSandbox(normalizeDenTypeId("sandboxOrganization", id), c.req.valid("json").days)
    return sandbox ? c.json({ sandbox }) : c.json({ error: "not_found", message: "Sandbox not found." }, 404)
  })

  app.post(`${base}/:sandboxId/credit`, updated("Set a sandbox's model credit", "Sets the spending cap, in US dollars, on the sandbox's own OpenRouter key (the total, not an increment). 400 when the sandbox uses the deployment's shared key. Platform administrators only."), adminRoute(), jsonValidator(sandboxCreditInputSchema), async c => {
    if (env.features.deployment !== "cloud") return c.json(disabled, 404)
    const id = c.req.param("sandboxId")
    if (!isDenTypeId("sandboxOrganization", id)) return c.json({ error: "invalid_request", message: "Invalid sandbox id." }, 400)
    try {
      const sandbox = await setSandboxCredit(normalizeDenTypeId("sandboxOrganization", id), c.req.valid("json").creditUsd)
      return sandbox ? c.json({ sandbox }) : c.json({ error: "not_found", message: "Sandbox not found." }, 404)
    } catch (error) {
      if (error instanceof SandboxInputError) return c.json({ error: "invalid_request", message: error.message }, 400)
      throw error
    }
  })

  app.post(`${base}/:sandboxId/close`, updated("Close a sandbox", "Stops the join link, included models and Free Auto now, returns the Enterprise plan the sandbox granted to Free, and disables the sandbox's own model key. The organization, its members, connectors and data are kept and the sandbox can be reopened. Platform administrators only."), adminRoute(), async c => {
    if (env.features.deployment !== "cloud") return c.json(disabled, 404)
    const id = c.req.param("sandboxId")
    if (!isDenTypeId("sandboxOrganization", id)) return c.json({ error: "invalid_request", message: "Invalid sandbox id." }, 400)
    const sandbox = await closeSandbox(normalizeDenTypeId("sandboxOrganization", id))
    return sandbox ? c.json({ sandbox }) : c.json({ error: "not_found", message: "Sandbox not found." }, 404)
  })
}
