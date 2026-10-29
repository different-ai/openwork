import { getLibraryAddConnectorRoute, getLibraryConnectorRoute, getLibraryMyAgentRoute } from "../../_lib/den-org";

/** Fixed internal destinations only; never accept an arbitrary return URL. */
export function fromMyAgent(href: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}from=my-agent`;
}

export function myAgentGoogleHref(orgSlug: string | null | undefined, connectionId?: string): string {
  return fromMyAgent(connectionId
    ? getLibraryConnectorRoute(orgSlug, connectionId)
    : getLibraryAddConnectorRoute(orgSlug, "google-workspace"));
}

export function connectorReturnToAgent(orgSlug: string | null | undefined, from: string | null) {
  return from === "my-agent" ? { href: getLibraryMyAgentRoute(orgSlug), label: "My bot" } : null;
}
