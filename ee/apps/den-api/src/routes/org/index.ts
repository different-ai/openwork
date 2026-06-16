import type { Hono } from "hono"
import { delegatedRoute } from "../../middleware/index.js"
import { registerOrgApiKeyRoutes } from "./api-keys.js"
import { registerOrgBillingRoutes } from "./billing.js"
import { LEGACY_ORG_PROXY_HEADER } from "../../middleware/user-organizations.js"
import type { OrgRouteVariables } from "./shared.js"
import { registerOrgCoreRoutes } from "./core.js"
import { registerOrgDesktopPolicyRoutes } from "./desktop-policies.js"
import { registerOrgInvitationRoutes } from "./invitations.js"
import { registerOrgInferenceRoutes } from "./inference.js"
import { registerOrgLlmProviderRoutes } from "./llm-providers.js"
import { registerOrgMemberRoutes } from "./members.js"
import { registerPluginArchRoutes } from "./plugin-system/routes.js"
import { registerOrgRoleRoutes } from "./roles.js"
import { registerOrgScimRoutes } from "./scim.js"
import { registerOrgSsoRoutes } from "./sso.js"
import { registerOrgSkillRoutes } from "./skills.js"
import { registerOrgResourceRoutes } from "./resources.js"
import { registerOrgTeamRoutes } from "./teams.js"

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
  registerOrgBillingRoutes(app)
  registerOrgDesktopPolicyRoutes(app)
  registerOrgInferenceRoutes(app)
  registerOrgScimRoutes(app)
  registerOrgSsoRoutes(app)
  registerOrgInvitationRoutes(app)
  registerOrgLlmProviderRoutes(app)
  registerOrgMemberRoutes(app)
  registerPluginArchRoutes(app)
  registerOrgRoleRoutes(app)
  registerOrgResourceRoutes(app)
  registerOrgSkillRoutes(app)
  registerOrgTeamRoutes(app)

  app.all("/v1/orgs/:orgId/*", delegatedRoute, async (c) => {
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

    return app.fetch(proxiedRequest)
  })
}
