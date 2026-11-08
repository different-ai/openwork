import { connectorIconCandidates } from "@openwork/types/connector-brand"

/**
 * The same brand resolver as Den's connector catalog and Workbot's Apps response. This also supplies the small
 * marks in chat connector lines (e.g. Searching Exa), so known brands don't depend on one host's separate name map.
 * Bundled images live on Den's configured origin; older hosts without it can still use CDN/favicon candidates.
 */
export function appIconCandidates(name: string, denUrl: string | null): string[] {
  return connectorIconCandidates({ name }).flatMap((src) => {
    if (!src.startsWith("/")) return [src]
    return denUrl ? [new URL(src, denUrl).href] : []
  })
}
