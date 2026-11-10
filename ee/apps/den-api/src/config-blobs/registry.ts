/**
 * Every config-blob area, in CONFIG_AREA_KEYS order. The engine sorts them by
 * `dependsOn` itself. `scripts/check-config-blob-coverage.ts` checks that each
 * org-scoped table is owned by one of these or listed in `excluded.ts`.
 */
import { CONFIG_AREA_KEYS, type ConfigAreaKey } from "@openwork/types/den/config-blobs"
import type { ConfigArea } from "./area.js"
import { aiGatewayByokArea } from "./areas/ai-gateway-byok.js"
import { aiGatewayLimitsArea } from "./areas/ai-gateway-limits.js"
import { aiGatewayOpenWorkModelsArea } from "./areas/ai-gateway-openwork-models.js"
import { aiGatewayProvidersArea } from "./areas/ai-gateway-providers.js"
import { aiGatewaySmartRoutersArea } from "./areas/ai-gateway-smart-routers.js"
import { connectorsMcpArea } from "./areas/connectors-mcp.js"
import { connectorsOAuthClientsArea } from "./areas/connectors-oauth-clients.js"
import { desktopPoliciesArea } from "./areas/desktop-policies.js"
import { membersAgentPermissionsArea } from "./areas/members-agent-permissions.js"
import { membersDefaultModelsArea } from "./areas/members-default-models.js"
import { membersPeopleArea } from "./areas/members-people.js"
import { membersPromptsArea } from "./areas/members-prompts.js"
import { membersRolesArea } from "./areas/members-roles.js"
import { membersTeamsArea } from "./areas/members-teams.js"
import { pluginsPluginsArea } from "./areas/plugins-plugins.js"
import { pluginsSkillsArea } from "./areas/plugins-skills.js"
import { pluginsSourcesArea } from "./areas/plugins-sources.js"
import { settingsAuditArea } from "./areas/settings-audit.js"
import { settingsAuthSecurityArea } from "./areas/settings-auth-security.js"
import { settingsBrandArea } from "./areas/settings-brand.js"
import { settingsCollectionsArea } from "./areas/settings-collections.js"
import { settingsGeneralArea } from "./areas/settings-general.js"
import { settingsWebOriginsArea } from "./areas/settings-web-origins.js"
import { workbotProactiveArea } from "./areas/workbot-proactive.js"
import { workbotSettingsArea } from "./areas/workbot-settings.js"
import { workbotTeamSettingsArea } from "./areas/workbot-team-settings.js"

const AREAS_BY_KEY: Record<ConfigAreaKey, ConfigArea> = {
  "members.teams": membersTeamsArea,
  "members.roles": membersRolesArea,
  "members.people": membersPeopleArea,
  "connectors.oauth-clients": connectorsOAuthClientsArea,
  "connectors.mcp": connectorsMcpArea,
  "ai-gateway.providers": aiGatewayProvidersArea,
  "ai-gateway.byok": aiGatewayByokArea,
  "desktop-policies": desktopPoliciesArea,
  "settings.general": settingsGeneralArea,
  "settings.web-origins": settingsWebOriginsArea,
  "settings.advanced.collections": settingsCollectionsArea,
  "members.agent-permissions": membersAgentPermissionsArea,
  "members.default-models": membersDefaultModelsArea,
  "members.prompts": membersPromptsArea,
  "ai-gateway.limits": aiGatewayLimitsArea,
  "ai-gateway.smart-routers": aiGatewaySmartRoutersArea,
  "ai-gateway.openwork-models": aiGatewayOpenWorkModelsArea,
  "plugins.plugins": pluginsPluginsArea,
  "plugins.skills": pluginsSkillsArea,
  "plugins.sources": pluginsSourcesArea,
  "workbot.settings": workbotSettingsArea,
  "workbot.proactive": workbotProactiveArea,
  "workbot.team-settings": workbotTeamSettingsArea,
  "settings.auth-security": settingsAuthSecurityArea,
  "settings.advanced.brand": settingsBrandArea,
  "settings.audit": settingsAuditArea,
}

export const CONFIG_AREAS: ConfigArea[] = CONFIG_AREA_KEYS.map((key) => AREAS_BY_KEY[key])

export function getConfigArea(key: ConfigAreaKey): ConfigArea {
  return AREAS_BY_KEY[key]
}
