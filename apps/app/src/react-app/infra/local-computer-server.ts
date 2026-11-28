import { openworkServerInfo } from "@/app/lib/desktop"
import { createOpenworkServerClient, isLoopbackOpenworkServerUrl, type OpenworkServerClient } from "@/app/lib/openwork-server"

export type LocalComputerServer = { client: OpenworkServerClient; identity: string }

export async function readLocalComputerServer(): Promise<LocalComputerServer | null> {
  const info = await openworkServerInfo()
  if (!info?.running || !info.baseUrl || !info.hostToken || !isLoopbackOpenworkServerUrl(info.baseUrl)) return null
  return {
    client: createOpenworkServerClient({ baseUrl: info.baseUrl, hostToken: info.hostToken, token: info.ownerToken ?? undefined }),
    identity: JSON.stringify([info.baseUrl, info.pid, info.generation, info.hostToken, info.ownerToken]),
  }
}
