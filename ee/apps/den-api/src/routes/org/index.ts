import type { Hono } from "hono"
import { registerOrgApiKeyRoutes } from "./api-keys.js"
import { LEGACY_ORG_PROXY_HEADER } from "../../middleware/user-organizations.js"
import type { OrgRouteVariables } from "./shared.js"
import { registerOrgCoreRoutes } from "./core.js"
import { registerOrgInvitationRoutes } from "./invitations.js"
import { registerOrgLlmProviderRoutes } from "./llm-providers.js"
import { registerOrgMemberRoutes } from "./members.js"
import { registerPluginArchRoutes } from "./plugin-system/routes.js"
import { registerOrgRoleRoutes } from "./roles.js"
import { registerOrgSkillRoutes } from "./skills.js"
import { registerOrgTeamRoutes } from "./teams.js"
import { registerOrgTemplateRoutes } from "./templates.js"

const LEGACY_ORG_PATH_PREFIX = "/v1/orgs/"

function extractLegacyOrgProxyTarget(pathname: string) {
  if (!pathname.startsWith(LEGACY_ORG_PATH_PREFIX)) {
    return null
  }

  const remainder = pathname.slice(LEGACY_ORG_PATH_PREFIX.length)
  const slashIndex = remainder.indexOf("/")
  if (slashIndex <= 0) {
    return null
  }

  const organizationId = remainder.slice(0, slashIndex)
  if (!organizationId.startsWith("org_")) {
    return null
  }

  const targetPath = `/v1${remainder.slice(slashIndex)}`
  if (targetPath === pathname) {
    return null
  }

  return { organizationId, targetPath }
}

export function registerOrgRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOrgCoreRoutes(app)
  registerOrgApiKeyRoutes(app)
  registerOrgInvitationRoutes(app)
  registerOrgLlmProviderRoutes(app)
  registerOrgMemberRoutes(app)
  registerPluginArchRoutes(app)
  registerOrgRoleRoutes(app)
  registerOrgSkillRoutes(app)
  registerOrgTeamRoutes(app)
  registerOrgTemplateRoutes(app)

  app.all("/v1/orgs/:orgId/*", async (c) => {
    const url = new URL(c.req.raw.url)
    const target = extractLegacyOrgProxyTarget(url.pathname)
    if (!target) {
      return c.json({ error: "not_found" }, 404)
    }

    const proxiedUrl = new URL(url)
    proxiedUrl.pathname = target.targetPath

    const headers = new Headers(c.req.raw.headers)
    headers.set(LEGACY_ORG_PROXY_HEADER, target.organizationId)

    const proxiedRequest = new Request(new Request(proxiedUrl, c.req.raw), { headers })

    return app.fetch(proxiedRequest, c.env)
  })
}
