import type { Hono } from "hono"
import { registerOrgApiKeyRoutes } from "./api-keys.js"
import type { OrgRouteVariables } from "./shared.js"
import { registerOrgCoreRoutes } from "./core.js"
import { registerOrgInvitationRoutes } from "./invitations.js"
import { registerOrgLlmProviderRoutes } from "./llm-providers.js"
import { registerOrgMemberRoutes } from "./members.js"
import { registerOrgRoleRoutes } from "./roles.js"
import { registerOrgSkillRoutes } from "./skills.js"
import { registerOrgTeamRoutes } from "./teams.js"
import { registerOrgTemplateRoutes } from "./templates.js"

export function registerOrgRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOrgCoreRoutes(app)
  registerOrgApiKeyRoutes(app)
  registerOrgInvitationRoutes(app)
  registerOrgLlmProviderRoutes(app)
  registerOrgMemberRoutes(app)
  registerOrgRoleRoutes(app)
  registerOrgSkillRoutes(app)
  registerOrgTeamRoutes(app)
  registerOrgTemplateRoutes(app)
}
