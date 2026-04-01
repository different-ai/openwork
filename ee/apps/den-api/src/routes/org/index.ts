import type { Hono } from "hono"
import type { OrgRouteVariables } from "./shared.js"
import { registerOrgCoreRoutes } from "./core.js"
import { registerOrgInvitationRoutes } from "./invitations.js"
import { registerOrgMemberRoutes } from "./members.js"
import { registerOrgRoleRoutes } from "./roles.js"
import { registerOrgSkillRoutes } from "./skills.js"
import { registerOrgTemplateRoutes } from "./templates.js"

export function registerOrgRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOrgCoreRoutes(app)
  registerOrgInvitationRoutes(app)
  registerOrgMemberRoutes(app)
  registerOrgRoleRoutes(app)
  registerOrgSkillRoutes(app)
  registerOrgTemplateRoutes(app)
}
