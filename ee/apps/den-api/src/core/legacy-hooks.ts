// SEAM(W0-05): side-effect registration of today's implementations, standing in
// for `core/hooks/legacy/index.ts`. Import it before membership mutations or
// authority checks run (app.ts and standalone scripts). W0-05 moves each block
// into `core/hooks/legacy/<owner>.ts`; module plans then register from their
// manifests with `moduleId` set.
import { memberApiKeyPruningParticipant } from "../capability-sources/member-api-key-membership.js"
import { gatewayUsageEntitlementParticipant } from "../gateway-usage-membership.js"
import { scimProjectionAuthorityExclusion } from "../scim-authority-projection.js"
import { adminTeamElevationContributor } from "../teams-authority.js"
import {
  freezeCoreHookSeams,
  registerAuthorityContributor,
  registerAuthorityExclusion,
  registerMembershipMutationParticipant,
} from "./hook-seams.js"

// legacy owner: connect (external MCP member API keys)
registerMembershipMutationParticipant(memberApiKeyPruningParticipant)
// legacy owner: aiGateway.usageLimits
registerMembershipMutationParticipant(gatewayUsageEntitlementParticipant)
// legacy owner: teams
registerAuthorityContributor(adminTeamElevationContributor)
// legacy owner: enterpriseAuth.scim
registerAuthorityExclusion(scimProjectionAuthorityExclusion)

freezeCoreHookSeams()
