"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, Search } from "lucide-react"
import type { ConnectorCatalog } from "@openwork/types/connection-action-app"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { openDesktopUrl } from "@/app/lib/desktop"
import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { isConnectAdminRole } from "@/react-app/domains/settings/connect-cloud-readiness"
import { libraryConnectorIconUrls } from "@/react-app/domains/settings/library-connector-cues"
import { useMessageList } from "./message-list-provider"

const SETUP_LABELS: Record<ConnectorCatalog["entries"][number]["setup"], string> = {
  oauth: "Sign in", oauth_client: "Admin setup", api_key: "API key", instant: "Ready to add", suite: "Guided setup",
}

function ConnectorIcon({ entry }: { entry: ConnectorCatalog["entries"][number] }) {
  const [failed, setFailed] = useState(false)
  const icon = libraryConnectorIconUrls({ id: entry.id, name: entry.name, serviceUrl: entry.serviceUrl, iconSlug: entry.id })[0]
  return <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-xs font-medium">
    {icon && !failed ? <img src={icon} alt="" className="size-5 object-contain" onError={() => setFailed(true)} /> : entry.name.charAt(0)}
  </span>
}

export function ConnectorCatalogCard({ catalog }: { catalog: ConnectorCatalog }) {
  const [showAll, setShowAll] = useState(catalog.selectedIds.length === 0)
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const auth = useDenAuth()
  const settings = readDenSettings()
  const identity = auth.verifiedIdentity
  const role = useQuery({
    queryKey: ["connector-catalog-role", settings.baseUrl, identity?.principalId, identity?.organizationId],
    enabled: auth.isSignedIn && Boolean(identity),
    queryFn: async () => {
      const result = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken }).listOrgs()
      return result.orgs.find(org => org.id === identity?.organizationId)?.role ?? null
    },
  })
  const { connectorIdentities } = useMessageList()
  const canManage = auth.isSignedIn && isConnectAdminRole(role.data)
  const entries = catalog.entries.filter(entry => (showAll || catalog.selectedIds.includes(entry.id)) && `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase()))
  const setup = async (entry: ConnectorCatalog["entries"][number]) => {
    if (!canManage) return
    setError(null)
    try {
      const expected = new URL("/dashboard/mcp-connections", readDenSettings().baseUrl)
      expected.searchParams.set("quickAdd", entry.id)
      // The model cannot supply a new setup destination or extra query parameters.
      if (entry.setupUrl !== expected.toString()) throw new Error("Your OpenWork server changed. Search for this connector again.")
      await openDesktopUrl(expected.toString())
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open setup.") }
  }
  return <section data-testid="connector-catalog" aria-label="Quick-add connectors" className="w-full max-w-md rounded-xl bg-muted/30 p-3">
    <div className="mb-2 flex items-center justify-between gap-3">
      <p className="text-xs font-medium">{showAll ? "Quick-add connectors" : "Suggested connector"}</p>
      {!showAll ? <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => setShowAll(true)}>Browse all {catalog.entries.length}</Button> : <span className="text-xs text-muted-foreground">{catalog.entries.length} available</span>}
    </div>
    {showAll ? <div className="relative mb-2"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input aria-label="Filter connectors" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a connector…" className="h-8 border-0 bg-background/70 pl-7 text-xs shadow-none" /></div> : null}
    <div className="max-h-80 overflow-y-auto">
      {entries.map(entry => {
        const added = Boolean(entry.serviceUrl && connectorIdentities.some(identity => identity.serviceUrl === entry.serviceUrl))
        return <div key={entry.id} data-connector-preset={entry.id} className="flex items-center gap-2.5 rounded-lg px-1 py-2">
          <ConnectorIcon entry={entry} />
          <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{entry.name}</p><p className="text-[11px] text-muted-foreground">{added ? "Added to your organization" : SETUP_LABELS[entry.setup]}</p></div>
          {!added ? <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!canManage} onClick={() => void setup(entry)} aria-label={`Set up ${entry.name}`}>Set up<ArrowUpRight className="size-3.5 text-muted-foreground" /></Button> : null}
        </div>
      })}
      {entries.length === 0 ? <p className="py-3 text-xs text-muted-foreground">No connectors match your search.</p> : null}
    </div>
    <p className="mt-2 text-[11px] text-muted-foreground">{canManage ? "Setup opens in organization settings." : "An organization admin can add these connectors for you."}</p>
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
  </section>
}
