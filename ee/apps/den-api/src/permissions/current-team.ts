type TeamLink = { teamId: string; teamName: string | null; removedAt: Date | null }

/** Active roles have only active teams. Archived details may retain their last team for history. */
export function currentTeam<Link extends TeamLink>(links: readonly Link[] | undefined, archived = false): { id: Link["teamId"]; name: string | null } | null {
  if (!links || links.length === 0) return null
  const active = links.filter((entry) => entry.removedAt === null)
  const link = active[active.length - 1] ?? (archived ? links[0] : undefined)
  return link ? { id: link.teamId, name: link.teamName } : null
}
