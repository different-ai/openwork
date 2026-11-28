import { eventThreadForPrincipal } from "../mcp-events/context.js"
import type { McpPrincipal } from "../mcp/auth.js"
import type { listMemberRemoteDeviceRows, RemoteDeviceActor } from "../remote-devices.js"

export async function resolveComputerSource(principal: McpPrincipal, actor: RemoteDeviceActor, devices: Awaited<ReturnType<typeof listMemberRemoteDeviceRows>>) {
  const thread = await eventThreadForPrincipal(principal)
  if (!thread || thread.organizationId !== actor.organizationId || thread.memberId !== actor.memberId) return null
  return devices.find(({ row }) => row.provider === "workbot" && row.externalId === thread.sessionId && row.ownerMemberId === actor.memberId) ?? null
}
