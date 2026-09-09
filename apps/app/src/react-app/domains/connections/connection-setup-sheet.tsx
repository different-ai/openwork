import { useEffect, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { ConnectionSetup, CreateSetupConnection } from "@openwork/types/connection-setup"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { openDesktopUrl } from "@/app/lib/desktop"
import type { useConnectionSetup } from "./use-connection-setup"

type Controller = ReturnType<typeof useConnectionSetup>
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
const busyPhases = new Set(["loading", "opening", "waiting", "checking"])

function SetupForm({ setup, controller }: { setup: ConnectionSetup; controller: Controller }) {
  const target = setup.target
  const [name, setName] = useState(target?.name ?? "")
  const [credentialMode, setCredentialMode] = useState<"per_member" | "shared">(target?.authType === "oauth" ? "per_member" : "shared")
  const [audience, setAudience] = useState("me")
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [apiKey, setApiKey] = useState("")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [clientAuthMethod, setClientAuthMethod] = useState<"client_secret_basic" | "client_secret_post" | undefined>()
  const [scopesText, setScopesText] = useState([...new Set([...(setup.requirements?.authentication.requiredScopes ?? []), ...(setup.requirements?.authentication.recommendedScopes ?? [])])].join(" "))
  const [tenantId, setTenantId] = useState("")
  const [features, setFeatures] = useState(target?.features.filter(feature => feature.selected).map(feature => feature.id) ?? [])
  const issuers = setup.requirements?.authentication.authorizationServers ?? []
  const [issuer, setIssuer] = useState(issuers.length === 1 ? issuers[0]?.issuer ?? "" : "")
  const [advanced, setAdvanced] = useState(target?.requiresOAuthClient ?? false)
  if (!target) return null
  const busy = busyPhases.has(controller.phase)
  const invalidDiscovery = setup.requirements?.status === "unreachable" || setup.requirements?.status === "unsupported" || setup.requirements?.authentication.kind === "unknown"
  const disabled = busy || !name.trim() || (target.authType === "apikey" && !apiKey.trim()) || (target.requiresOAuthClient && !clientId.trim()) || (target.requiresTenant && !tenantId.trim()) || (issuers.length > 1 && !issuer) || invalidDiscovery

  function toggle(values: string[], value: string) { return values.includes(value) ? values.filter(item => item !== value) : [...values, value] }
  const submit = () => {
    const values: Omit<CreateSetupConnection, "externalKey"> = {
      kind: target.kind, name: name.trim(), url: target.url, nativeProviderKey: target.nativeProviderKey,
      authType: target.authType, credentialMode,
      ...(target.authType === "apikey" ? { apiKey: apiKey.trim() } : {}),
      ...(clientId.trim() ? { oauthClient: { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}), ...(clientAuthMethod ? { tokenEndpointAuthMethod: clientAuthMethod } : {}), features, ...(tenantId.trim() ? { tenantId: tenantId.trim() } : {}) } } : {}),
      ...(issuer ? { authorizationServerIssuer: issuer } : {}),
      requestedScopes: [...new Set(scopesText.split(/[\s,]+/).filter(Boolean))],
      access: { orgWide: audience === "organization", memberIds: audience === "organization" ? [] : [...new Set([setup.memberId, ...(audience === "selected" ? memberIds : [])])], teamIds: audience === "selected" ? teamIds : [] },
    }
    // Remove secrets from the visible form as soon as they enter the authenticated request.
    setApiKey("")
    setClientSecret("")
    void controller.submit(values)
  }
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); submit() }}>
    <div className="space-y-2"><Label htmlFor="connection-name">Connection name</Label><Input id="connection-name" value={name} onChange={event => setName(event.target.value)} disabled={busy} /></div>
    {target.authType === "oauth" && target.kind !== "native_provider" ? <div className="space-y-2"><Label htmlFor="connection-account-mode">Account</Label><select id="connection-account-mode" className={selectClass} value={credentialMode} disabled={busy} onChange={event => setCredentialMode(event.target.value === "shared" ? "shared" : "per_member")}><option value="per_member">Each person signs in</option><option value="shared">One shared account</option></select><p className="text-xs text-muted-foreground">{credentialMode === "per_member" ? "You'll connect your account next. Other people sign in separately." : "Everyone granted access will use the account you connect."}</p></div> : null}
    <div className="space-y-2"><Label htmlFor="connection-audience">Who can use this connection?</Label><select id="connection-audience" className={selectClass} value={audience} disabled={busy} onChange={event => setAudience(event.target.value)}><option value="me">Only me</option><option value="selected">Me and selected people or teams</option><option value="organization">Everyone in the organization</option></select></div>
    {audience === "selected" ? <div className="space-y-2" aria-label="Connection access">{setup.members.filter(member => member.id !== setup.memberId).map(member => <label key={member.id} className="flex items-center gap-2"><Checkbox checked={memberIds.includes(member.id)} onCheckedChange={() => setMemberIds(toggle(memberIds, member.id))} disabled={busy} />{member.name}</label>)}{setup.teams.map(team => <label key={team.id} className="flex items-center gap-2"><Checkbox checked={teamIds.includes(team.id)} onCheckedChange={() => setTeamIds(toggle(teamIds, team.id))} disabled={busy} />{team.name} <span className="text-xs text-muted-foreground">Team</span></label>)}</div> : null}
    {target.authType === "apikey" ? <div className="space-y-2"><Label htmlFor="connection-api-key">API key</Label><Input id="connection-api-key" type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} /><p className="text-xs text-muted-foreground">Saved securely for this connection. Never added to the conversation.</p></div> : null}
    {target.authType === "oauth" ? <>
      {!target.requiresOAuthClient ? <Button type="button" variant="ghost" className="px-0" onClick={() => setAdvanced(!advanced)}>OAuth app settings</Button> : null}
      {advanced ? <div className="space-y-4 rounded-lg bg-muted/40 p-4">
        <p className="font-medium">OAuth app</p>
        <div className="space-y-2"><Label htmlFor="connection-callback">Redirect URI</Label><Input id="connection-callback" value={target.callbackUrl} readOnly /><p className="text-xs text-muted-foreground">Add this redirect URI in your provider's app settings.</p></div>
        <div className="space-y-2"><Label htmlFor="connection-client-id">Client ID</Label><Input id="connection-client-id" autoComplete="off" value={clientId} disabled={busy} onChange={event => setClientId(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="connection-client-secret">Client secret</Label><Input id="connection-client-secret" type="password" autoComplete="off" value={clientSecret} disabled={busy} onChange={event => setClientSecret(event.target.value)} /></div>
        {target.kind === "external_mcp" ? <>
          <div className="space-y-2"><Label htmlFor="connection-client-auth">Client authentication</Label><select id="connection-client-auth" className={selectClass} value={clientAuthMethod ?? ""} disabled={busy} onChange={event => setClientAuthMethod(event.target.value === "client_secret_basic" || event.target.value === "client_secret_post" ? event.target.value : undefined)}><option value="">Use provider defaults</option><option value="client_secret_basic">Client secret in Authorization header</option><option value="client_secret_post">Client secret in request body</option></select></div>
          <div className="space-y-2"><Label htmlFor="connection-scopes">Requested scopes</Label><Input id="connection-scopes" value={scopesText} disabled={busy} onChange={event => setScopesText(event.target.value)} /><p className="text-xs text-muted-foreground">Start with the server's suggested scopes. Your provider may require additional permissions.</p></div>
        </> : null}
        {target.requiresTenant ? <div className="space-y-2"><Label htmlFor="connection-tenant">Microsoft Entra tenant</Label><Input id="connection-tenant" value={tenantId} disabled={busy} onChange={event => setTenantId(event.target.value)} placeholder="Tenant ID or verified domain" /></div> : null}
      </div> : null}
      {issuers.length > 1 ? <div className="space-y-2"><Label htmlFor="connection-issuer">Sign-in provider</Label><select id="connection-issuer" value={issuer} className={selectClass} onChange={event => setIssuer(event.target.value)}><option value="">Choose a sign-in provider</option>{issuers.map(server => <option key={server.issuer} value={server.issuer}>{new URL(server.issuer).hostname}</option>)}</select></div> : null}
      {target.features.length > 0 ? <fieldset className="space-y-2"><legend className="mb-2 font-medium">Features</legend>{target.features.map(feature => <label className="flex items-center gap-2" key={feature.id}><Checkbox disabled={busy} checked={features.includes(feature.id)} onCheckedChange={() => setFeatures(toggle(features, feature.id))} />{feature.label}</label>)}</fieldset> : null}
    </> : null}
    {invalidDiscovery ? <p role="alert" className="text-sm text-destructive">We couldn't verify this server's setup requirements. Check its address and try again.</p> : null}
    <Button type="submit" className="w-full" disabled={disabled}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{target.authType === "oauth" ? "Save and sign in" : "Save and connect"}</Button>
  </form>
}

export function ConnectionSetupSheet({ controller }: { controller: Controller }) {
  const { setup, phase, connection, error } = controller
  const [address, setAddress] = useState("")
  const [replacementKey, setReplacementKey] = useState("")
  const [replacementClientId, setReplacementClientId] = useState("")
  const [replacementClientSecret, setReplacementClientSecret] = useState("")
  const [replacementTenantId, setReplacementTenantId] = useState("")
  useEffect(() => { if (!controller.open) { setReplacementKey(""); setReplacementClientSecret("") } }, [controller.open])
  const busy = busyPhases.has(phase)
  const status = phase === "loading" ? "Checking setup requirements…" : phase === "opening" ? "Opening sign-in…" : phase === "waiting" ? "Finish sign-in in your browser" : phase === "checking" ? "Checking connection and tools…" : phase === "ready" ? "Ready to use" : null
  return <Sheet open={controller.open} onOpenChange={controller.setOpen}>
    <SheetContent className="w-full overflow-y-auto sm:max-w-md" data-testid="connection-setup-sheet">
      <SheetHeader><SheetTitle>{setup?.target?.name ?? "Set up a connection"}</SheetTitle><SheetDescription>{setup?.target?.kind === "native_provider" ? "Connect your work account without leaving this task." : "Configure the service, connect your account, and continue your task."}</SheetDescription></SheetHeader>
      <div className="space-y-5 px-6 pb-6" aria-live="polite">
        {setup?.target ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Connection details</summary><p className="mt-2 break-all">{setup.target.url}</p></details> : null}
        {status ? <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-3" role="status">{phase === "ready" ? <Check className="size-4" /> : <Loader2 className="size-4 animate-spin" />}{status}</div> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {phase === "unsupported" ? <><p className="text-sm text-muted-foreground">This OpenWork server doesn't support setup in the app yet. You can finish connecting in organization settings.</p><Button className="w-full" onClick={() => void controller.openSettings()}>Open organization setup</Button></> : null}
        {setup?.message ? <p className="text-sm text-muted-foreground">{setup.message}</p> : null}
        {setup && !setup.target ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void controller.load(address) }}><Label htmlFor="connection-address">MCP server URL</Label><Input id="connection-address" value={address} onChange={event => setAddress(event.target.value)} placeholder="https://service.example/mcp" /><Button disabled={!address.trim()} type="submit">Check server</Button></form> : null}
        {setup && setup.connections.length > 1 && !busy && phase !== "ready" ? <div className="space-y-2"><Label htmlFor="connection-existing">Choose a connection</Label><select id="connection-existing" className={selectClass} value={connection?.id ?? ""} onChange={event => { const selected = setup.connections.find(entry => entry.id === event.target.value); if (selected) controller.select(selected) }}><option value="">Choose an account</option>{setup.connections.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.externalAccountId ? ` · ${entry.externalAccountId}` : ""}</option>)}</select></div> : null}
        {setup?.target && setup.canManage && !connection && setup.connections.length === 0 ? <SetupForm key={`${setup.organizationId}:${setup.memberId}:${setup.target.url}`} setup={setup} controller={controller} /> : null}
        {connection && phase !== "ready" && !busy ? <Button className="w-full" disabled={!connection.canUse || phase === "blocked"} onClick={() => void controller.submit()}>{connection.connectedForMe || connection.authType !== "oauth" ? "Check connection" : "Sign in"}</Button> : null}
        {connection?.authType === "apikey" && setup?.canManage && phase !== "ready" ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void controller.replaceCredentials({ apiKey: replacementKey }); setReplacementKey("") }}><Label htmlFor="replacement-api-key">Replacement API key</Label><Input id="replacement-api-key" type="password" autoComplete="off" value={replacementKey} disabled={busy} onChange={event => setReplacementKey(event.target.value)} /><Button type="submit" variant="outline" className="w-full" disabled={busy || !replacementKey.trim()}>Update key and check</Button></form> : null}
        {phase === "blocked" ? <Button variant="outline" onClick={() => void controller.load(controller.query)}>Check access again</Button> : null}
        {connection?.authType === "oauth" && setup?.canManage && phase !== "ready" ? <details className="space-y-3"><summary className="cursor-pointer text-sm">Update OAuth app</summary><form className="space-y-3" onSubmit={event => {
          event.preventDefault()
          void controller.replaceCredentials({ oauthClient: { clientId: replacementClientId.trim(), ...(replacementClientSecret ? { clientSecret: replacementClientSecret } : {}), ...(replacementTenantId.trim() ? { tenantId: replacementTenantId.trim() } : {}) } })
          setReplacementClientSecret("")
        }}>
          <Label htmlFor="replacement-client-id">Client ID</Label><Input id="replacement-client-id" value={replacementClientId} disabled={busy} onChange={event => setReplacementClientId(event.target.value)} />
          <Label htmlFor="replacement-client-secret">Client secret</Label><Input id="replacement-client-secret" type="password" autoComplete="off" value={replacementClientSecret} disabled={busy} onChange={event => setReplacementClientSecret(event.target.value)} />
          {setup.target?.requiresTenant ? <><Label htmlFor="replacement-tenant">Microsoft Entra tenant</Label><Input id="replacement-tenant" value={replacementTenantId} disabled={busy} onChange={event => setReplacementTenantId(event.target.value)} placeholder="Leave blank to keep the existing tenant" /></> : null}
          <p className="text-xs text-muted-foreground">Leave the secret blank to preserve it when the client ID is unchanged.</p>
          <Button type="submit" className="w-full" disabled={busy || !replacementClientId.trim()}>Update app and sign in</Button>
        </form></details> : null}
        {phase === "waiting" ? <Button variant="outline" onClick={controller.stopWaiting}>Stop waiting</Button> : null}
        {controller.authorizeUrl ? <Button variant="outline" className="w-full" onClick={() => { if (controller.authorizeUrl) void openDesktopUrl(controller.authorizeUrl) }}>Open sign-in</Button> : null}
        {phase === "failed" && !connection ? <Button variant="outline" onClick={() => void controller.load(controller.query)}>Check setup again</Button> : null}
        {phase === "ready" ? <Button className="w-full" onClick={() => controller.setOpen(false)}>Back to task</Button> : null}
      </div>
    </SheetContent>
  </Sheet>
}
