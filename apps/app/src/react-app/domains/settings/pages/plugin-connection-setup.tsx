import { useEffect, useRef, useState } from "react";
import {
  DenApiError,
  type DenClient,
  type DenExternalMcpPreset,
  type DenPluginCloudReadiness,
  type DenPluginCloudReadinessConnection,
} from "../../../../app/lib/den";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import {
  emptyLibraryMcpConnectionForm,
  libraryMcpConnectionFormIncomplete,
  libraryMcpConnectionRequest,
  withLibraryMcpAuthType,
  type LibraryMcpAuthType,
  type LibraryMcpConnectionForm,
} from "../library";

export type PluginConnectionSetupProps = {
  pluginId: string;
  client: DenClient;
  organizationId: string;
  canManage: boolean;
  refreshKey?: number;
  onConfigureConnection: (connectionId: string) => void;
  onConnect: (connectionId: string) => Promise<void> | void;
  onChanged: () => Promise<void> | void;
  onReauthenticate: (retry: (client: DenClient) => Promise<void>) => void;
};

type Requirement = DenPluginCloudReadinessConnection;
type RequirementAction = "connect" | "configure" | "configure-requirement" | "create" | "none";
type RequirementPolicy = { label: string; action: RequirementAction };
type SetupRequest = Parameters<DenClient["configurePluginMcpConnection"]>[2];
type SavedConnection = Pick<SetupRequest, "authType" | "credentialMode"> & { connectionId: string };

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

export function pluginRequirementAuth(
  requirement: Requirement,
  presets: DenExternalMcpPreset[],
  selectedAuth: LibraryMcpAuthType | "" = "",
) {
  const url = normalizedUrl(requirement.url);
  const preset = url ? presets.find((entry) => normalizedUrl(entry.url) === url) : undefined;
  const existingAuth = requirement.authTypeMismatch ? null : requirement.authType;
  const requiredAuth = requirement.requiredAuthType ?? (requirement.id && requirement.authType === "apikey" ? "apikey" : null);
  const authTypes: LibraryMcpAuthType[] = requiredAuth
    ? [requiredAuth]
    : preset
      ? [...new Set(preset.supportedAuthTypes?.length ? preset.supportedAuthTypes : [preset.authType])]
      : existingAuth ? [existingAuth] : ["oauth", "apikey", "none"];
  const defaultAuth = requiredAuth
    ?? (preset ? authTypes.find((type) => type === preset.authType) ?? authTypes[0] : existingAuth)
    ?? null;
  const locked = authTypes.length === 1;
  const authType = locked ? authTypes[0] : selectedAuth && authTypes.includes(selectedAuth) ? selectedAuth : defaultAuth;
  return {
    authType,
    authTypes,
    locked,
    apiKeyLabel: preset?.presetId === "github" ? "Personal access token (PAT)" : "API key",
    requiresOAuthClient: authType === "oauth" && (requirement.oauthClientRequired === true || preset?.requiresOAuthClient === true),
  };
}

function formWithAuthType(form: LibraryMcpConnectionForm, authType: LibraryMcpAuthType): LibraryMcpConnectionForm {
  return {
    ...withLibraryMcpAuthType(form, authType),
    credentialMode: authType === "oauth" ? form.authType === "oauth" ? form.credentialMode : "per_member" : "shared",
    apiKey: authType === "apikey" ? form.apiKey : "",
  };
}

function initialRequirementForm(requirement: Requirement, presets: DenExternalMcpPreset[]) {
  return formWithAuthType(emptyLibraryMcpConnectionForm(), pluginRequirementAuth(requirement, presets).authType ?? "oauth");
}

function isBoundApiKeyRequirement(requirement: Requirement) {
  return Boolean(requirement.id
    && requirement.authType === "apikey"
    && (!requirement.requiredAuthType || requirement.requiredAuthType === "apikey")
    && requirement.configObjectId?.trim()
    && requirement.serverName?.trim());
}

export function pluginRequirementPolicy(
  requirement: Requirement,
  readiness: DenPluginCloudReadiness["state"],
  canManage: boolean,
): RequirementPolicy {
  if (readiness === "desktop_only") return { label: "Desktop-only requirement", action: "none" };
  if (readiness === "not_synced") return { label: "Waiting for plugin sync", action: "none" };
  if (!requirement.id) {
    const hasTarget = Boolean(requirement.configObjectId?.trim() && requirement.serverName?.trim());
    return { label: "Needs admin setup", action: canManage && hasTarget ? "create" : "none" };
  }
  const keyAction: RequirementAction = canManage && isBoundApiKeyRequirement(requirement) ? "configure-requirement" : "none";
  if (requirement.authType === "apikey" && (!requirement.requiredAuthType || requirement.requiredAuthType === "apikey")) {
    if (requirement.connectedForMe === true && !requirement.authTypeMismatch) return { label: "Ready to use", action: keyAction };
    if (requirement.connectedForMe === false || requirement.authTypeMismatch) return { label: "Needs admin setup", action: keyAction };
  }
  if (requirement.authTypeMismatch || ((requirement.authType ?? requirement.requiredAuthType) === "oauth" && requirement.oauthClientRequired && !requirement.oauthClientConfigured)) {
    return { label: "Needs admin setup", action: canManage ? "configure" : "none" };
  }
  if (requirement.connectedForMe === true) return { label: "Ready to use", action: "none" };
  if (requirement.connectedForMe === false) {
    if (requirement.authType === "none") {
      return { label: "Needs admin setup", action: canManage ? "configure" : "none" };
    }
    if (requirement.authType === "oauth" || readiness === "needs_signin") {
      if (requirement.credentialMode === "per_member") return { label: "Needs your sign-in", action: "connect" };
      if (requirement.credentialMode === "shared") return { label: "Needs organization sign-in", action: canManage ? "connect" : "none" };
    }
  }
  return { label: "Connection status unavailable", action: "none" };
}

export function pluginRequirementSetupRequest(
  requirement: Requirement,
  presets: DenExternalMcpPreset[],
  form: LibraryMcpConnectionForm,
  selectedAuth: LibraryMcpAuthType | "",
): SetupRequest {
  if (requirement.id && requirement.authType !== "apikey") throw new Error("This requirement already has a connection. Configure that connection instead.");
  if (!requirement.configObjectId?.trim() || !requirement.serverName?.trim()) {
    throw new Error("The server did not return the exact plugin requirement. Refresh its status before configuring it.");
  }
  if (requirement.id && (!isBoundApiKeyRequirement(requirement) || (selectedAuth && selectedAuth !== "apikey"))) {
    throw new Error("Only the API key for this bound requirement can be updated here.");
  }
  const policy = pluginRequirementAuth(requirement, presets, selectedAuth);
  if (!policy.locked && selectedAuth && !policy.authTypes.includes(selectedAuth)) {
    throw new Error("This authentication method is not supported by this server.");
  }
  const authType = policy.authType;
  if (!authType) throw new Error("Choose how this server authenticates.");
  const connection = {
    ...formWithAuthType(form, authType),
    useOAuthClient: authType === "oauth" && (policy.requiresOAuthClient || form.useOAuthClient),
  };
  if (libraryMcpConnectionFormIncomplete(connection)) throw new Error("Enter an API key.");
  if (authType === "oauth" && connection.useOAuthClient && !connection.oauthClientId.trim()) {
    throw new Error("Enter the OAuth client ID.");
  }
  return {
    configObjectId: requirement.configObjectId,
    serverName: requirement.serverName,
    ...libraryMcpConnectionRequest(connection),
  };
}

function needsReauthentication(error: unknown) {
  return error instanceof DenApiError && error.status === 403 && error.code === "reauth";
}

const fieldClass = "rounded-xl border-transparent bg-dls-hover shadow-none focus:border-transparent focus:ring-0";
const authLabels: Record<LibraryMcpAuthType, string> = {
  oauth: "OAuth",
  apikey: "API key",
  none: "No authentication",
};

export function PluginConnectionSetup(props: PluginConnectionSetupProps) {
  const [readiness, setReadiness] = useState<DenPluginCloudReadiness | null>(null);
  const [presets, setPresets] = useState<DenExternalMcpPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const request = useRef(0);

  async function refresh(client: DenClient, scope = generation.current) {
    if (generation.current !== scope) return;
    const run = ++request.current;
    const current = () => generation.current === scope && request.current === run;
    setLoading(true);
    setError(null);
    try {
      const [resolved, catalog] = await Promise.all([
        client.getLibraryPlugin(props.organizationId, props.pluginId),
        props.canManage ? client.listMcpConnectionPresets(props.organizationId) : Promise.resolve([]),
      ]);
      if (!current()) return;
      setReadiness(resolved.cloudReadiness ?? null);
      setPresets(catalog);
    } catch (cause) {
      if (!current()) return;
      if (needsReauthentication(cause)) {
        setError("Verify your identity to load connection requirements.");
        props.onReauthenticate((nextClient) => refresh(nextClient, scope));
      } else {
        setError("Could not refresh connection requirements. Refresh status to try again.");
      }
    } finally {
      if (current()) setLoading(false);
    }
  }

  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [props.client, props.organizationId, props.pluginId, props.canManage]);

  useEffect(() => {
    void refresh(props.client);
  }, [props.client, props.organizationId, props.pluginId, props.canManage, props.refreshKey]);

  return (
    <section className="flex flex-col gap-3" aria-label="Plugin connections" aria-busy={loading}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Connections</h3>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void refresh(props.client)}>
          {loading ? "Refreshing…" : "Refresh status"}
        </Button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-11">{error}</p> : null}
      {!readiness && !loading && !error ? <p className="text-sm text-dls-secondary">Connection requirements are unavailable. No readiness has been confirmed.</p> : null}
      {readiness ? (
        <>
          <p className="text-xs text-dls-secondary">
            {error ? "Showing the last known requirements." : readiness.state === "ready" ? "Plugin connections are ready to use." : readiness.state === "desktop_only" ? "This plugin has requirements that only run on Desktop." : readiness.state === "not_synced" ? "This plugin has not finished syncing." : "Finish the required setup or account sign-in below."}
          </p>
          {readiness.connections.map((requirement) => (
            <PluginRequirementRow
              key={JSON.stringify([requirement.configObjectId, requirement.serverName, requirement.url])}
              {...props}
              requirement={requirement}
              readiness={readiness.state}
              presets={presets}
              stale={loading || Boolean(error)}
              refresh={refresh}
            />
          ))}
          {readiness.connections.length === 0 ? <p className="text-sm text-dls-secondary">No remote connection requirements were returned.</p> : null}
        </>
      ) : null}
    </section>
  );
}

function PluginRequirementRow(props: PluginConnectionSetupProps & {
  requirement: Requirement;
  readiness: DenPluginCloudReadiness["state"];
  presets: DenExternalMcpPreset[];
  stale: boolean;
  refresh: (client: DenClient) => Promise<void>;
}) {
  const { requirement } = props;
  const [selectedAuth, setSelectedAuth] = useState<LibraryMcpAuthType | "">("");
  const auth = pluginRequirementAuth(requirement, props.presets, selectedAuth);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<LibraryMcpConnectionForm>(() => initialRequirementForm(requirement, props.presets));
  const [saved, setSaved] = useState<SavedConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingReauth, setAwaitingReauth] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const savedId = useRef<string | null>(null);
  const pending = useRef<SetupRequest | null>(null);
  const pendingBindingId = useRef<string | null>(null);
  const boundId = useRef(requirement.id);
  const effectiveAuth = auth.authType;
  const effectiveRequirement: Requirement = saved && requirement.id !== saved.connectionId
    ? { ...requirement, id: saved.connectionId, authType: saved.authType, credentialMode: saved.credentialMode, connectedForMe: false, authTypeMismatch: false, oauthClientRequired: false }
    : requirement;
  const policy = pluginRequirementPolicy(effectiveRequirement, props.readiness, props.canManage);
  const disabled = busy || awaitingReauth || props.stale;
  const bindingConfirmed = !saved || requirement.id === saved.connectionId;
  const inlineSetup = policy.action === "create" || policy.action === "configure-requirement";
  const showOAuthClient = effectiveAuth === "oauth" && (auth.requiresOAuthClient || form.useOAuthClient);

  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
      pending.current = null;
    };
  }, [props.organizationId, props.pluginId, props.canManage]);

  useEffect(() => {
    boundId.current = requirement.id;
    if (requirement.id !== pendingBindingId.current) pending.current = null;
  }, [requirement.id]);

  async function save(client: DenClient, scope: number) {
    if (generation.current !== scope || inFlight.current || savedId.current || !pending.current || !props.canManage) return;
    if (boundId.current !== pendingBindingId.current || (boundId.current && pending.current.authType !== "apikey")) return;
    inFlight.current = true;
    setBusy(true);
    setAwaitingReauth(false);
    setError(null);
    const body = pending.current;
    try {
      const result = await client.configurePluginMcpConnection(props.organizationId, props.pluginId, body);
      if (generation.current !== scope) return;
      savedId.current = result.connectionId;
      pending.current = null;
      setSaved({ connectionId: result.connectionId, authType: body.authType, credentialMode: body.credentialMode });
      setForm(initialRequirementForm(requirement, props.presets));
      setFormOpen(false);
      await props.refresh(client);
      if (generation.current !== scope) return;
      await props.onChanged();
    } catch (cause) {
      if (generation.current !== scope) return;
      if (!savedId.current && needsReauthentication(cause)) {
        setAwaitingReauth(true);
        props.onReauthenticate((nextClient) => save(nextClient, scope));
      } else {
        pending.current = null;
        setForm(initialRequirementForm(requirement, props.presets));
        if (savedId.current) {
          setError("Configuration was saved, but its latest status could not be confirmed. Refresh status; do not create another connection.");
        } else {
          const rejected = cause instanceof DenApiError && [400, 401, 403, 404, 409, 422].includes(cause.status);
          setUncertain(!rejected);
          setError(rejected ? "The connection configuration was rejected. Check the selected authentication and credentials, then refresh status." : "The setup result is unknown. Refresh status to check for an existing connection before continuing.");
        }
      }
    } finally {
      inFlight.current = false;
      if (generation.current === scope) setBusy(false);
    }
  }

  function startSetup() {
    if (disabled || uncertain || !bindingConfirmed || inFlight.current || !inlineSetup) return;
    generation.current += 1;
    savedId.current = null;
    pending.current = null;
    pendingBindingId.current = requirement.id;
    setSaved(null);
    setForm(initialRequirementForm(requirement, props.presets));
    setSelectedAuth("");
    setError(null);
    setFormOpen(true);
  }

  function submit() {
    if (disabled || uncertain || savedId.current || !inlineSetup) return;
    try {
      pending.current = pluginRequirementSetupRequest(requirement, props.presets, form, selectedAuth);
      pendingBindingId.current = requirement.id;
      void save(props.client, generation.current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the connection configuration.");
    }
  }

  function cancelSetup() {
    generation.current += 1;
    pending.current = null;
    setAwaitingReauth(false);
    setForm(initialRequirementForm(requirement, props.presets));
    setSelectedAuth("");
    setFormOpen(false);
    setError(null);
  }

  async function connect() {
    const connectionId = requirement.id ?? savedId.current;
    if (!connectionId || inFlight.current || disabled) return;
    const scope = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.onConnect(connectionId);
      if (generation.current !== scope) return;
      await props.refresh(props.client);
      if (generation.current !== scope) return;
      await props.onChanged();
    } catch {
      if (generation.current === scope) setError("Sign-in did not complete. The connection is still configured; refresh status before trying again.");
    } finally {
      inFlight.current = false;
      if (generation.current === scope) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-dls-hover/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{requirement.name || requirement.serverName}</p>
          <p className="mt-1 text-xs text-dls-secondary">{policy.label}</p>
        </div>
        {policy.action === "connect" ? <Button type="button" size="sm" disabled={disabled} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</Button> : null}
        {policy.action === "configure" ? <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { if (effectiveRequirement.id) props.onConfigureConnection(effectiveRequirement.id); }}>Configure connection</Button> : null}
        {inlineSetup && !formOpen && !uncertain ? <Button type="button" variant="outline" size="sm" disabled={disabled || !bindingConfirmed} onClick={startSetup}>{policy.action === "configure-requirement" ? "Update API key" : "Set up connection"}</Button> : null}
      </div>
      {saved ? <p role="status" className="text-xs text-dls-secondary">Configuration saved. {policy.label === "Ready to use" ? "Connection readiness confirmed." : saved.authType === "oauth" ? "Account consent is a separate step; use Connect to authorize the account." : "Refresh status to confirm the connection is ready."}</p> : null}
      {!props.canManage && policy.label === "Needs admin setup" ? <p className="text-xs text-dls-secondary">An organization admin must configure this requirement before you can use it.</p> : null}
      {error ? <p role="alert" className="text-sm text-red-11">{error}</p> : null}
      {awaitingReauth ? (
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-dls-secondary">Waiting for identity verification. If verification was canceled, cancel this setup to continue.</p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancelSetup}>Cancel</Button>
        </div>
      ) : null}
      {formOpen && inlineSetup && !uncertain ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <p className="break-all text-xs text-dls-secondary">{requirement.url}</p>
          {auth.locked && auth.authType ? <p className="text-xs text-dls-secondary">Authentication: {auth.authType === "apikey" ? auth.apiKeyLabel : authLabels[auth.authType]}</p> : (
            <label className="text-xs font-medium text-dls-secondary">
              Authentication
              <select className={`mt-1 w-full px-3 py-2 text-sm ${fieldClass}`} value={effectiveAuth ?? ""} disabled={disabled} onChange={(event) => {
                const value = event.currentTarget.value;
                if (value !== "oauth" && value !== "apikey" && value !== "none") return;
                if (!auth.authTypes.includes(value)) return;
                setSelectedAuth(value);
                setForm((current) => formWithAuthType(current, value));
              }}>
                <option value="" disabled>Choose authentication</option>
                {auth.authTypes.map((type) => <option key={type} value={type}>{type === "apikey" ? auth.apiKeyLabel : authLabels[type]}</option>)}
              </select>
            </label>
          )}
          {effectiveAuth === "apikey" ? <TextInput label={auth.apiKeyLabel} type="password" autoComplete="new-password" spellCheck={false} className={fieldClass} value={form.apiKey} disabled={disabled} onChange={(event) => { const apiKey = event.currentTarget.value; setForm((current) => ({ ...current, apiKey })); }} /> : null}
          {effectiveAuth === "oauth" ? (
            <>
              <label className="text-xs font-medium text-dls-secondary">
                Account access
                <select className={`mt-1 w-full px-3 py-2 text-sm ${fieldClass}`} value={form.credentialMode} disabled={disabled} onChange={(event) => { const credentialMode = event.currentTarget.value === "shared" ? "shared" : "per_member"; setForm((current) => ({ ...current, credentialMode })); }}>
                  <option value="per_member">Each member connects their account</option>
                  <option value="shared">Organization-shared account</option>
                </select>
              </label>
              {!showOAuthClient ? <Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled} onClick={() => setForm((current) => ({ ...current, useOAuthClient: true }))}>Use an OAuth client</Button> : null}
              {showOAuthClient ? (
                <>
                  <TextInput label="OAuth client ID" autoComplete="off" spellCheck={false} className={fieldClass} value={form.oauthClientId} disabled={disabled} onChange={(event) => { const oauthClientId = event.currentTarget.value; setForm((current) => ({ ...current, oauthClientId })); }} />
                  <TextInput label="OAuth client secret" type="password" autoComplete="new-password" spellCheck={false} className={fieldClass} value={form.oauthClientSecret} disabled={disabled} onChange={(event) => { const oauthClientSecret = event.currentTarget.value; setForm((current) => ({ ...current, oauthClientSecret })); }} />
                </>
              ) : null}
            </>
          ) : null}
          <p className="text-xs text-dls-secondary">{requirement.id ? "The new key is validated before this plugin switches connections. Other plugin bindings are not changed; access continues to follow this plugin." : "Access follows this plugin. Configuration does not authorize an account."}</p>
          <div className="flex justify-end gap-2">
            {!awaitingReauth ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancelSetup}>Cancel</Button> : null}
            <Button type="submit" size="sm" disabled={disabled || !effectiveAuth}>{busy ? "Saving…" : "Save configuration"}</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
