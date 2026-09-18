import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TextInput } from "../../../design-system/text-input";
import { DenApiError, type DenClient, type DenExternalMcpConnection, type DenExternalMcpPreset, type DenMcpConnectionInput } from "../../../../app/lib/den";
import { openDesktopUrl } from "../../../../app/lib/desktop";
import { connectionNeedsReconnect } from "../../connections/native-provider-connections";
import { NativeProviderSetup } from "./native-provider-setup";

type Props = {
  client: DenClient;
  organizationId: string;
  principalId: string;
  canManage: boolean;
  connectionId?: string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onReauthenticate: (retry: (client: DenClient) => Promise<void>) => void;
};
type NativeKey = "google-workspace" | "microsoft-365";
type Page = { kind: "catalog" } | { kind: "external"; preset?: DenExternalMcpPreset; connection?: DenExternalMcpConnection } | { kind: "native"; providerKey: NativeKey; connectionId?: string } | { kind: "status"; id: string };

export function libraryConnectionReady(connection: DenExternalMcpConnection): boolean {
  return !connection.setupRequired && !connectionNeedsReconnect(connection)
    && (connection.credentialMode === "shared" ? connection.connected : connection.connectedForMe);
}

export function mergeLibraryConnections(manageable: DenExternalMcpConnection[], usable: DenExternalMcpConnection[]): DenExternalMcpConnection[] {
  const byId = new Map(manageable.map((connection) => [connection.id, connection]));
  for (const connection of usable) {
    const managed = byId.get(connection.id);
    byId.set(connection.id, managed ? { ...managed, ...connection, access: managed.access } : connection);
  }
  return [...byId.values()];
}

function nativeKey(connection: DenExternalMcpConnection): NativeKey | null {
  const key = connection.nativeProviderKey ?? connection.id;
  return key === "google-workspace" || key === "microsoft-365" ? key : null;
}

/** All async work belongs to the identity-pinned mount supplied by Library. */
export function LibraryConnectionSetup(props: Props) {
  const [page, setPage] = useState<Page>(props.connectionId ? { kind: "status", id: props.connectionId } : { kind: "catalog" });
  const [connections, setConnections] = useState<DenExternalMcpConnection[]>([]);
  const [presets, setPresets] = useState<DenExternalMcpPreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const polling = useRef(0);
  const client = useRef(props.client);
  const inFlight = useRef(false);
  const pageId = page.kind === "status" ? page.id : null;
  const selected = connections.find((entry) => entry.id === pageId);
  const refreshRun = useRef(0);

  async function refresh(activeClient = client.current) {
    const run = ++refreshRun.current;
    const usable = await activeClient.listMcpConnections(props.organizationId, "usable");
    const manageable = props.canManage ? await activeClient.listMcpConnections(props.organizationId, "manageable") : [];
    // Usable owns native aliases and this member's missing-scope state. Manageable
    // owns administrator-only setup rows, including shared accounts without a grant.
    const result = mergeLibraryConnections(manageable, usable);
    if (alive.current && run === refreshRun.current) setConnections(result);
    return result;
  }
  async function load() {
    setBusy(true);
    setError(null);
    try {
      const [_, catalog] = await Promise.all([refresh(), props.canManage ? client.current.listMcpConnectionPresets(props.organizationId) : Promise.resolve([])]);
      if (alive.current) setPresets(catalog);
    } catch (cause) {
      if (alive.current) setError(cause instanceof DenApiError ? cause.message : "Could not load connections. Refresh status to try again.");
    } finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; polling.current += 1; refreshRun.current += 1; };
  }, []);

  function onReauthenticate(retry: (next: DenClient) => Promise<void>) {
    props.onReauthenticate(async (next) => {
      if (!alive.current) return;
      client.current = next;
      await retry(next);
    });
  }
  async function changed(id: string) {
    polling.current += 1;
    setWaiting(false);
    setPage({ kind: "status", id });
    try {
      await refresh();
      if (alive.current) await props.onChanged();
    } catch {
      if (alive.current) setError("Configuration was saved. Refresh status to confirm readiness; do not add it again.");
    }
  }
  async function configure(connection: DenExternalMcpConnection) {
    if (!props.canManage || inFlight.current) return;
    polling.current += 1;
    setWaiting(false);
    const providerKey = nativeKey(connection);
    if (providerKey) { setPage({ kind: "native", providerKey, connectionId: connection.id }); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const detail = await client.current.getMcpConnection(props.organizationId, connection.id);
      if (alive.current) setPage({ kind: "external", connection: detail });
    } catch (cause) {
      if (alive.current) setError(cause instanceof DenApiError ? cause.message : "Could not load this connection's settings.");
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function connect(connection: DenExternalMcpConnection) {
    if (inFlight.current || waiting || (connection.credentialMode === "shared" && !props.canManage)) return;
    inFlight.current = true;
    const generation = ++polling.current;
    const current = () => alive.current && polling.current === generation;
    setBusy(true);
    setError(null);
    try {
      // Check first: a previous browser attempt may have completed after its UI timed out.
      const entries = await refresh();
      if (!current()) return;
      const latest = entries.find((entry) => entry.id === connection.id);
      if (latest && libraryConnectionReady(latest)) { await props.onChanged(); return; }
      const result = await client.current.startMcpConnectionConnect(props.organizationId, connection.id);
      if (!current()) return;
      if (result.status === "connected") { await refresh(); await props.onChanged(); return; }
      if (!result.authorizeUrl) throw new Error("The provider did not return an authorization address.");
      await openDesktopUrl(result.authorizeUrl);
      if (!current()) return;
      setWaiting(true);
      setBusy(false);
      const started = Date.now();
      while (current() && Date.now() - started < 90_000) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        if (!current()) return;
        try {
          const refreshed = await refresh();
          if (!current()) return;
          const match = refreshed.find((entry) => entry.id === connection.id);
          if (match && libraryConnectionReady(match)) { await props.onChanged(); return; }
        } catch { /* A bounded poll tolerates transient reads, never repeats authorization. */ }
      }
      if (current()) setError("Sign-in has not been confirmed. Check the provider window, then Refresh status before trying again. Your saved connection is kept.");
    } catch (cause) {
      if (current()) setError(cause instanceof DenApiError ? cause.message : "Could not complete sign-in. Refresh status, or review the connection settings.");
    } finally {
      inFlight.current = false;
      if (current()) { setBusy(false); setWaiting(false); }
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Set up a connection</DialogTitle>
        <DialogDescription>Configuration stays in OpenWork. Only provider consent opens your browser.</DialogDescription>
      </DialogHeader>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="min-h-0 overflow-y-auto space-y-4">
        {page.kind === "catalog" ? <>
          {props.canManage ? <>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setPage({ kind: "native", providerKey: "google-workspace" })}>Google Workspace</Button>
              <Button variant="outline" onClick={() => setPage({ kind: "native", providerKey: "microsoft-365" })}>Microsoft 365</Button>
              <Button variant="outline" onClick={() => setPage({ kind: "external" })}>Custom MCP</Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((preset) => <Button key={preset.presetId} variant="outline" className="justify-start" onClick={() => setPage({ kind: "external", preset })}>{preset.displayName}</Button>)}
            </div>
          </> : <p className="text-sm text-dls-secondary">Connect any service your organization has shared with you. An administrator must add or configure other services.</p>}
          <h3 className="text-sm font-medium">Available connections</h3>
          {connections.map((connection) => <Button key={connection.id} variant="outline" className="w-full justify-between" onClick={() => setPage({ kind: "status", id: connection.id })}><span>{connection.name}</span><span className="text-xs text-dls-secondary">{libraryConnectionReady(connection) ? "Ready to use" : connection.setupRequired || connection.credentialMode === "shared" ? "Needs admin setup" : "Needs sign-in"}</span></Button>)}
          {!busy && connections.length === 0 ? <p className="text-sm text-dls-secondary">No connections are available yet.</p> : null}
          <Button variant="outline" disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : "Refresh status"}</Button>
        </> : null}
        {page.kind === "external" ? <ExternalConnectionForm key={page.connection?.id ?? page.preset?.presetId ?? "custom"} {...props} client={client.current} preset={page.preset} connection={page.connection} onSaved={(id) => void changed(id)} onCancel={() => setPage({ kind: "catalog" })} onReauthenticate={onReauthenticate} /> : null}
        {page.kind === "native" ? <NativeProviderSetup key={page.connectionId ?? page.providerKey} providerKey={page.providerKey} connectionId={page.connectionId} client={client.current} organizationId={props.organizationId} onSaved={(id) => void changed(id)} onCancel={() => setPage({ kind: "catalog" })} onReauthenticate={onReauthenticate} /> : null}
        {page.kind === "status" ? <>
          <h3 className="text-base font-medium">{selected?.name ?? "Saved connection"}</h3>
          <p role="status" className="text-sm">{selected ? libraryConnectionReady(selected) ? "Ready to use" : selected.setupRequired ? "Needs admin setup" : "Configuration saved. Account sign-in is still required." : "Refresh status to confirm this connection's readiness."}</p>
          {waiting ? <p role="status" className="text-sm">Waiting for provider sign-in. Return here after approving access.</p> : null}
          <div className="flex flex-wrap gap-2">
            {selected && !libraryConnectionReady(selected) && !selected.setupRequired && selected.authType === "oauth" && (selected.credentialMode === "per_member" || props.canManage) ? <Button disabled={busy || waiting} onClick={() => void connect(selected)}>Connect account</Button> : null}
            {selected && props.canManage ? <Button variant="outline" disabled={busy || waiting} onClick={() => void configure(selected)}>Configure connection</Button> : null}
            <Button variant="outline" disabled={busy} onClick={() => void load()}>Refresh status</Button>
          </div>
        </> : null}
      </div>
      {page.kind === "catalog" || page.kind === "status" ? <div className="flex justify-end"><Button onClick={props.onClose}>Done</Button></div> : null}
    </DialogContent>
  </Dialog>;
}

type ExternalFields = { name: string; url: string; authType: DenMcpConnectionInput["authType"]; credentialMode: DenMcpConnectionInput["credentialMode"]; apiKey: string; clientId: string; clientSecret: string; scopes: string; issuer: string; orgWide: boolean; exposeDirectly: boolean };
export function libraryExternalConnectionInput(fields: ExternalFields, memberId: string | null, connection?: DenExternalMcpConnection): DenMcpConnectionInput {
  if (!connection && !fields.orgWide && !memberId) throw new Error("Your organization membership could not be confirmed. Reload setup before saving.");
  if (connection && !connection.access) throw new Error("The existing access grants could not be loaded. Reload setup before saving.");
  if (connection?.identityManagedBy?.length && fields.apiKey.trim()) throw new Error("Update this API key from the owning plugin's Connections section.");
  if (connection?.identityManagedBy?.length && (fields.url !== connection.url || fields.authType !== connection.authType || fields.credentialMode !== connection.credentialMode)) throw new Error("This plugin manages the connection identity. Only its credentials can be edited here.");
  return {
    name: fields.name.trim(), url: fields.url.trim(), authType: fields.authType,
    credentialMode: fields.authType === "oauth" ? fields.credentialMode : "shared",
    exposeDirectly: fields.exposeDirectly,
    access: connection?.access ?? { orgWide: fields.orgWide, memberIds: fields.orgWide ? [] : memberId ? [memberId] : [], teamIds: [] },
    ...(fields.authType === "apikey" && fields.apiKey.trim() ? { apiKey: fields.apiKey.trim() } : {}),
    ...(fields.authType === "oauth" ? {
      // Omission preserves preset defaults and plugin-owned registration policy.
      ...(!connection?.identityManagedBy?.length && (connection ? fields.scopes !== (connection.requestedScopes ?? []).join(" ") : Boolean(fields.scopes.trim()))
        ? { requestedScopes: fields.scopes.split(/\s+/).filter(Boolean) } : {}),
      ...(!connection?.identityManagedBy?.length && (connection ? fields.issuer !== (connection.authorizationServerIssuer ?? "") : Boolean(fields.issuer.trim()))
        ? { authorizationServerIssuer: fields.issuer.trim() || null } : {}),
      ...(fields.clientId.trim() && (!connection || fields.clientId.trim() !== connection.oauthClientId || fields.clientSecret.trim())
        ? { oauthClient: { clientId: fields.clientId.trim(), ...(fields.clientSecret.trim() ? { clientSecret: fields.clientSecret.trim() } : {}) } } : {}),
    } : {}),
  };
}

function ExternalConnectionForm(props: Props & { preset?: DenExternalMcpPreset; connection?: DenExternalMcpConnection; onSaved: (id: string) => void; onCancel: () => void }) {
  const { connection, preset } = props;
  const authTypes: ExternalFields["authType"][] = preset
    ? [...new Set(preset.supportedAuthTypes?.length ? preset.supportedAuthTypes : [preset.authType])]
    : ["oauth", "apikey", "none"];
  const defaultAuth = connection?.authType ?? preset?.authType ?? "oauth";
  const [fields, setFields] = useState<ExternalFields>({ name: connection?.name ?? preset?.displayName ?? "", url: connection?.url ?? preset?.url ?? "", authType: authTypes.includes(defaultAuth) ? defaultAuth : authTypes[0], credentialMode: connection?.credentialMode ?? "per_member", apiKey: "", clientId: connection?.oauthClientId ?? "", clientSecret: "", scopes: connection?.requestedScopes?.join(" ") ?? "", issuer: connection?.authorizationServerIssuer ?? "", orgWide: false, exposeDirectly: connection?.exposeDirectly ?? false });
  const [memberId, setMemberId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const saved = useRef(false);
  const locked = Boolean(connection?.identityManagedBy?.length);
  useEffect(() => {
    active.current = true;
    if (!connection) void props.client.getLibraryAccessTargets(props.organizationId).then((targets) => {
      if (active.current) setMemberId(targets.members.find((member) => member.userId === props.principalId)?.id ?? null);
    }).catch(() => { if (active.current) setError("Could not confirm your organization membership. Close and reopen setup to try again."); });
    return () => { active.current = false; };
  }, []);
  function change<K extends keyof ExternalFields>(key: K, value: ExternalFields[K]) { setFields((current) => ({ ...current, [key]: value })); }
  const missingKey = fields.authType === "apikey" && !fields.apiKey.trim() && (!connection || connection.authType !== "apikey" || fields.url !== connection.url);
  const clientRequired = fields.authType === "oauth" && (preset?.requiresOAuthClient || connection?.oauthClientRequired);
  const invalid = !authTypes.includes(fields.authType) || !fields.name.trim() || !fields.url.trim() || missingKey || (clientRequired && !fields.clientId.trim()) || (!connection && !fields.orgWide && !memberId);
  async function submit(client = props.client) {
    if (inFlight.current || saved.current || !active.current || !props.canManage || invalid || uncertain) return;
    let input: DenMcpConnectionInput;
    try { input = libraryExternalConnectionInput(fields, memberId, connection); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Review the connection settings."); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (connection && !connection.updatedAt) throw new Error("The server did not return a version for safe editing. Reload setup before saving.");
      const result = connection
        ? await client.updateMcpConnection(props.organizationId, connection.id, { ...input, expectedUpdatedAt: connection.updatedAt! })
        : await client.createMcpConnection(props.organizationId, input);
      if (!active.current) return;
      saved.current = true;
      setFields((current) => ({ ...current, apiKey: "", clientSecret: "" }));
      props.onSaved(result.id);
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof DenApiError && cause.code === "reauth") {
        props.onReauthenticate(async (verified) => { await submit(verified); });
      } else {
        const ambiguous = !(cause instanceof DenApiError) || cause.status >= 500;
        setUncertain(ambiguous);
        const message = ambiguous ? "The save result is unknown. Close setup and refresh Library before retrying to avoid duplicate changes." : cause.code === "connection_conflict" ? "This connection changed elsewhere. Close and reopen its settings before saving." : cause.message;
        setError([fields.apiKey, fields.clientSecret].filter(Boolean).reduce((text, secret) => text.split(secret).join("[redacted]"), message));
      }
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  return <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <fieldset disabled={busy || uncertain} className="space-y-3">
      <TextInput label="Name" aria-label="Name" value={fields.name} onChange={(event) => change("name", event.currentTarget.value)} required />
      <TextInput label="Server URL" aria-label="Server URL" value={fields.url} onChange={(event) => change("url", event.currentTarget.value)} required readOnly={locked} type="url" />
      <label className="block text-sm">Authentication<select aria-label="Authentication" className="mt-1 block w-full rounded-xl bg-dls-hover p-2" value={fields.authType} disabled={locked || authTypes.length === 1} onChange={(event) => { const value = event.currentTarget.value; if ((value === "oauth" || value === "apikey" || value === "none") && authTypes.includes(value)) change("authType", value); }}>
        {authTypes.map((type) => <option key={type} value={type}>{type === "oauth" ? "OAuth" : type === "apikey" ? "API key" : "No authentication"}</option>)}
      </select></label>
      {fields.authType === "apikey" ? locked ? <p className="text-xs text-dls-secondary">Update this API key from the owning plugin's Connections section. Its setup keeps all plugin bindings and access in sync.</p> : <TextInput label={connection ? "API key (optional replacement)" : "API key"} aria-label="API key" type="password" autoComplete="new-password" value={fields.apiKey} onChange={(event) => change("apiKey", event.currentTarget.value)} /> : null}
      {fields.authType === "oauth" ? <>
        <label className="block text-sm">Account access<select aria-label="Account access" className="mt-1 block w-full rounded-xl bg-dls-hover p-2" value={fields.credentialMode} disabled={locked} onChange={(event) => change("credentialMode", event.currentTarget.value === "shared" ? "shared" : "per_member")}><option value="per_member">Each member connects their account</option><option value="shared">Organization-shared account</option></select></label>
        {connection?.oauthCallbackUrl ? <TextInput label="Redirect URI" readOnly value={connection.oauthCallbackUrl} onFocus={(event) => event.currentTarget.select()} /> : null}
        <p className="text-xs text-dls-secondary">{clientRequired ? "This service requires a registered OAuth client." : "OpenWork registers an OAuth client automatically when the provider supports it. Supply an existing client only if required."}</p>
        <TextInput label="OAuth client ID" aria-label="OAuth client ID" value={fields.clientId} autoComplete="off" onChange={(event) => change("clientId", event.currentTarget.value)} />
        <TextInput label="OAuth client secret" aria-label="OAuth client secret" type="password" value={fields.clientSecret} autoComplete="new-password" onChange={(event) => change("clientSecret", event.currentTarget.value)} />
        <details><summary className="cursor-pointer text-sm">Advanced OAuth settings</summary><div className="mt-3 space-y-3"><TextInput label="Authorization server issuer" value={fields.issuer} onChange={(event) => change("issuer", event.currentTarget.value)} /><TextInput label="Requested scopes" value={fields.scopes} onChange={(event) => change("scopes", event.currentTarget.value)} /></div></details>
      </> : null}
      {connection ? <p className="text-xs text-dls-secondary">Existing member, team, and plugin access is preserved. Leave secret fields empty to retain stored credentials when the connection identity is unchanged.</p> : <label className="flex gap-2 text-sm"><input type="checkbox" checked={fields.orgWide} onChange={(event) => change("orgWide", event.currentTarget.checked)} />Share with everyone in the organization (otherwise only you)</label>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={fields.exposeDirectly} onChange={(event) => change("exposeDirectly", event.currentTarget.checked)} />Expose directly as an MCP server</label>
      <p className="text-xs text-dls-secondary">Credentials are stored encrypted in your organization's cloud, never in local MCP configuration. Saving OAuth settings does not authorize an account.</p>
    </fieldset>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>Cancel</Button><Button type="submit" disabled={busy || uncertain || invalid}>{busy ? "Saving…" : "Save connection"}</Button></div>
  </form>;
}
