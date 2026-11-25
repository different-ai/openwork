import { connectorIconCandidates } from "@openwork/types/connector-brand"

export function appIconCandidates(name: string, denUrl: string | null, site?: string): string[] {
  const url = site && /^[a-z0-9.-]{3,80}$/i.test(site) ? `https://${site.toLowerCase()}` : undefined
  return connectorIconCandidates({ name, url }).flatMap((src) => {
    if (!src.startsWith("/")) return [src]
    return denUrl ? [new URL(src, denUrl).href] : []
  })
}
