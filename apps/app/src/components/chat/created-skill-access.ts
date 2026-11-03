import { createDenClient, readDenSettings } from "@/app/lib/den"
import type { DenLibraryAccessGrant, DenLibraryOrgDirectory } from "@/app/lib/den-library"
import type { ConfirmedSkillAccess, SkillRecipient } from "@/lib/created-skill"

/** Live grants → the card's confirmed access. The owner's own grant is not "sharing". */
export function accessFromGrants(grants: DenLibraryAccessGrant[], directory: DenLibraryOrgDirectory | null): ConfirmedSkillAccess {
  const members = new Map((directory?.members ?? []).filter((member) => member.name !== member.id).map((member) => [member.id, member.name]))
  const teams = new Map((directory?.teams ?? []).map((team) => [team.id, team.name]))
  const recipients = grants.flatMap((grant): SkillRecipient[] => {
    if (grant.orgWide) return [{ kind: "organization", id: null, name: null }]
    if (grant.teamId) return [{ kind: "team", id: grant.teamId, name: teams.get(grant.teamId) ?? null }]
    if (grant.orgMembershipId && grant.orgMembershipId !== directory?.currentMemberId) {
      return [{ kind: "person", id: grant.orgMembershipId, name: members.get(grant.orgMembershipId) ?? null }]
    }
    return []
  })
  return recipients.length > 0 ? { kind: "shared", recipients } : { kind: "private" }
}

/**
 * Check status: read the plugin's current access with the signed-in Den
 * session. Read-only; it never repeats a share.
 */
export async function readCreatedSkillAccess(pluginId: string): Promise<ConfirmedSkillAccess> {
  const settings = readDenSettings()
  const token = settings.authToken?.trim()
  const organizationId = settings.activeOrgId?.trim()
  if (!token || !organizationId) throw new Error("Sign in to OpenWork Cloud to check who can use this skill.")
  const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token })
  const [grants, directory] = await Promise.all([
    client.listPluginAccess(organizationId, pluginId),
    client.getLibraryOrgDirectory(organizationId).catch(() => null),
  ])
  return accessFromGrants(grants, directory)
}
