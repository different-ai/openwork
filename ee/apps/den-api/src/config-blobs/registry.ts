/**
 * Every config-blob area, in CONFIG_AREA_KEYS order. The engine sorts them by
 * `dependsOn` itself. `scripts/check-config-blob-coverage.ts` checks that each
 * org-scoped table is owned by one of these or listed in `excluded.ts`.
 */
import { CONFIG_AREA_KEYS, type ConfigAreaKey } from "@openwork/types/den/config-blobs"
import type { ConfigArea } from "./area.js"
import { aiGatewayByokArea } from "./areas/ai-gateway-byok.js"
import { aiGatewayProvidersArea } from "./areas/ai-gateway-providers.js"
import { connectorsMcpArea } from "./areas/connectors-mcp.js"
import { connectorsOAuthClientsArea } from "./areas/connectors-oauth-clients.js"
import { desktopPoliciesArea } from "./areas/desktop-policies.js"
import { membersPeopleArea } from "./areas/members-people.js"
import { membersRolesArea } from "./areas/members-roles.js"
import { membersTeamsArea } from "./areas/members-teams.js"
import { settingsCollectionsArea } from "./areas/settings-collections.js"
import { settingsGeneralArea } from "./areas/settings-general.js"
import { settingsWebOriginsArea } from "./areas/settings-web-origins.js"

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
}

export const CONFIG_AREAS: ConfigArea[] = CONFIG_AREA_KEYS.map((key) => AREAS_BY_KEY[key])

export function getConfigArea(key: ConfigAreaKey): ConfigArea {
  return AREAS_BY_KEY[key]
}
