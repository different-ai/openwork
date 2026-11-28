import { eventThreadForPrincipal } from "../mcp-events/context.js"
import type { McpPrincipal } from "../mcp/auth.js"
import { listMemberRemoteDeviceRows, type RemoteDeviceActor } from "../remote-devices.js"

export async function resolveComputerSource(principal: McpPrincipal, actor: RemoteDeviceActor) {
  const thread = await eventThreadForPrincipal(principal)
  if (!thread || thread.organizationId !== actor.organizationId || thread.memberId !== actor.memberId) return null
  const devices = await listMemberRemoteDeviceRows(actor, { canManageShared: false })
  return devices.find(({ row }) => row.provider === "workbot" && row.externalId === thread.sessionId && row.ownerMemberId === actor.memberId) ?? null
}
