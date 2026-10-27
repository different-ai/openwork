"use client";

import { ChevronRight, Lock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import { DenInput } from "../../_components/ui/input";
import { ApiKeySchemeAdvanced } from "./connector-setup-fields";
import { ConfirmDialog } from "./item-list";
import { credentialModeForAuth } from "./member-api-key";
import { McpCredentialInput } from "./mcp-credential-input";
import { DETAILS_SUMMARY_CLASS, ManualOAuthFields } from "./manual-oauth-fields";
import { EMPTY_OAUTH_ADDRESSES, manualOAuthDraft, publishedAddressesUnsaved } from "./manual-oauth-draft";
import { apiKeyAuthSchemeInput, type ExternalMcpApiKeyAuthScheme, type ExternalMcpAuthType, type ExternalMcpCredentialMode, type ExternalMcpConnection, type McpIssuerReview, type UpdateMcpConnectionInput, useReviewMcpIssuer, useUpdateMcpConnection } from "./mcp-connections-data";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

/** Rename a connector, move its address, rotate its key, or replace its OAuth app, in place on its page. */
/** `lockedReason` shows the settings read-only with why (DESIGN.md P4), e.g. the caller can't edit this connection. */
export function ConnectorSettingsForm({ connection, onSaved, lockedReason = null }: { connection: ExternalMcpConnection; onSaved: (message: string) => void; lockedReason?: string | null }) {
  const updateConnection = useUpdateMcpConnection();
  const [name, setName] = useState(connection.name);
  const [url, setUrl] = useState(connection.url);
  const [authType, setAuthType] = useState<ExternalMcpAuthType>(connection.authType);
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>(connection.credentialMode);
  const [apiKeyAuthScheme, setApiKeyAuthScheme] = useState<ExternalMcpApiKeyAuthScheme>(connection.apiKeyAuthScheme);
  const [showOAuthApp, setShowOAuthApp] = useState(Boolean(connection.oauthClientId) || connection.oauthClientRequired === true);
  const [scopes, setScopes] = useState((connection.requestedScopes ?? []).join(" "));
  const [exposeDirectly, setExposeDirectly] = useState(connection.exposeDirectly);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState(connection.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [manualDraft, setManualDraft] = useState(() => manualOAuthDraft(connection.manualOAuthEndpoints ?? EMPTY_OAUTH_ADDRESSES));
  const manualAddresses = manualDraft.values;
  const usingPublishedAddresses = publishedAddressesUnsaved(manualDraft, connection.manualOAuthEndpoints ?? EMPTY_OAUTH_ADDRESSES);
  const manualChanged = manualAddresses.authorizationEndpoint.trim() !== (connection.manualOAuthEndpoints?.authorizationEndpoint ?? "") || manualAddresses.tokenEndpoint.trim() !== (connection.manualOAuthEndpoints?.tokenEndpoint ?? "");
  const halfSet = Boolean(manualAddresses.authorizationEndpoint.trim()) !== Boolean(manualAddresses.tokenEndpoint.trim());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managedByPlugin = connection.identityManagedBy.length > 0;
  const usesKey = authType === "apikey";
  const usesOAuthApp = authType === "oauth" && showOAuthApp;
  const chosenMode = credentialModeForAuth(authType, credentialMode);
  const usesSharedKey = usesKey && chosenMode === "shared";
  const usesPersonalKey = usesKey && chosenMode === "per_member";
  const normalizedApiKey = apiKey.trim();
  const identityChanged = url.trim() !== connection.url
    || authType !== connection.authType
    || chosenMode !== connection.credentialMode
    || (usesKey && apiKeyAuthScheme !== connection.apiKeyAuthScheme);
  const requestedScopes = [...new Set(scopes.split(/[\s,]+/).filter(Boolean))];
  const scopesChanged = requestedScopes.join(" ") !== (connection.requestedScopes ?? []).join(" ");
  const keepsSavedClientSecret = connection.oauthClientHasSecret === true && clientId.trim() === (connection.oauthClientId ?? "") && !identityChanged;
  const clientChanged = usesOAuthApp && (clientId.trim() !== (connection.oauthClientId ?? "") || Boolean(clientSecret.trim()) || ((manualChanged || identityChanged) && Boolean(manualAddresses.authorizationEndpoint.trim())));
  const changed = name.trim() !== connection.name || identityChanged || Boolean(usesSharedKey && normalizedApiKey) || clientChanged || scopesChanged || manualChanged || exposeDirectly !== connection.exposeDirectly;
  const keyRequired = usesSharedKey && identityChanged && !normalizedApiKey;
  const disabled = halfSet || (authType === "oauth" && Boolean(manualAddresses.authorizationEndpoint) && !clientId.trim()) || !changed || !name.trim() || !url.trim() || keyRequired || (clientChanged && !clientId.trim()) || !connection.updatedAt;

  async function save() {
    if (!connection.updatedAt) return;
    setError(null);
    const input: UpdateMcpConnectionInput = {
      connectionId: connection.id,
      expectedUpdatedAt: connection.updatedAt,
      name: name.trim(),
      url: url.trim(),
      authType,
      credentialMode: chosenMode,
      exposeDirectly,
      ...(authType === "oauth" && !managedByPlugin ? { requestedScopes } : {}),
      ...(authType === "oauth" && (manualChanged || (identityChanged && Boolean(manualAddresses.authorizationEndpoint.trim()))) ? { manualOAuthEndpoints: manualAddresses.authorizationEndpoint.trim() ? { authorizationEndpoint: manualAddresses.authorizationEndpoint.trim(), tokenEndpoint: manualAddresses.tokenEndpoint.trim() } : null } : {}),
      ...(!managedByPlugin ? apiKeyAuthSchemeInput(authType, apiKeyAuthScheme) : {}),
      ...(usesSharedKey && !managedByPlugin && normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
      ...(clientChanged && clientId.trim()
        ? { oauthClient: { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) } }
        : {}),
      access: connection.access ?? { orgWide: false, memberIds: [], teamIds: [] },
    };
    try {
      const updated = await updateConnection.mutateAsync(input);
      setApiKey("");
      setClientSecret("");
      setManualDraft(manualOAuthDraft(updated.manualOAuthEndpoints ?? EMPTY_OAUTH_ADDRESSES));
      onSaved(usesPersonalKey
        ? `${updated.name} is ready. Each person can now add their own key in My Library.`
        : updated.reconnectionRequired ? `${updated.name} is saved. Sign in again to use it.` : `${updated.name} is saved.`);
    } catch (cause) {
      setError(usesPersonalKey
        ? "The connection did not save. Check the settings and try again."
        : cause instanceof Error ? cause.message : "That did not save.");
    }
  }

  return (
    <>
    <form
      className="flex flex-col gap-3 px-5 py-4"
      data-testid="connector-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (identityChanged || manualChanged) setConfirming(true);
        else void save();
      }}
    >
      <fieldset disabled={lockedReason !== null} className="flex min-w-0 flex-col gap-3">
      <Field label="Name">
        <DenInput value={name} onChange={(event) => setName(event.target.value)} data-testid="connector-settings-name" />
      </Field>
      <Field label="Address">
        <DenInput value={url} onChange={(event) => setUrl(event.target.value)} disabled={managedByPlugin} data-testid="connector-settings-url" />
      </Field>
      {managedByPlugin ? <p className="text-[12px] text-gray-500">Server and sign-in settings are managed by the plugin owner.</p> : null}
      <Field label="Sign-in method">
        <DenSelect value={authType} disabled={managedByPlugin} onChange={(event) => {
          const value = event.target.value;
          if (value === "oauth" || value === "apikey" || value === "none") setAuthType(value);
        }}>
          <option value="oauth">Sign in with an account</option>
          <option value="apikey">API key</option>
          <option value="none">No sign-in</option>
        </DenSelect>
      </Field>
      <Field label="How people sign in">
        <DenSelect value={chosenMode} disabled={managedByPlugin || authType === "none"} onChange={(event) => {
          const value = event.target.value;
          if (value === "per_member" || value === "shared") setCredentialMode(value);
        }}>
          <option value="per_member">{usesKey ? "Each person adds a key" : "Each person signs in"}</option>
          <option value="shared">{usesKey ? "One key for everyone" : "One account for everyone"}</option>
        </DenSelect>
      </Field>
      {authType === "none" ? <p className="text-[12px] text-gray-500">This connection is shared; nobody signs in individually.</p> : null}
      {usesKey ? (
        <ApiKeySchemeAdvanced value={apiKeyAuthScheme} onChange={setApiKeyAuthScheme} disabled={managedByPlugin} testId="connector-settings-api-key-auth-scheme" />
      ) : null}
      {authType === "oauth" && !showOAuthApp ? <DenButton type="button" variant="secondary" size="sm" onClick={() => setShowOAuthApp(true)}>Add OAuth app</DenButton> : null}
      {usesSharedKey && !managedByPlugin ? (
        <Field label={keyRequired ? "New API key" : "New API key (optional)"}>
          <McpCredentialInput kind="secret" name="connector-settings-api-key" autoComplete="off" data-ph-no-capture value={apiKey} onChange={setApiKey} saved={connection.connected && !identityChanged} placeholder="API key" data-testid="connector-settings-api-key" replaceTestId="connector-settings-replace-api-key" />
        </Field>
      ) : null}
      {usesOAuthApp ? (
        <>
          <Field label="OAuth client ID">
            <McpCredentialInput kind="identifier" name="connector-settings-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID" />
          </Field>
          <Field label="New client secret (optional)">
            <McpCredentialInput kind="secret" name="connector-settings-client-secret" value={clientSecret} onChange={setClientSecret} saved={keepsSavedClientSecret} placeholder="Client secret" />
          </Field>
        </>
      ) : null}
      {authType === "oauth" ? <ManualOAuthFields url={url} draft={manualDraft} saved={connection.manualOAuthEndpoints ?? EMPTY_OAUTH_ADDRESSES} onChange={(value) => { setManualDraft(value); if (value.values.authorizationEndpoint) setShowOAuthApp(true); }} hasClientSecret={keepsSavedClientSecret || Boolean(clientSecret.trim())} disabled={managedByPlugin} /> : null}
      {authType === "oauth" ? (
        <Field label="Requested OAuth scopes">
          <DenInput value={scopes} disabled={managedByPlugin} onChange={(event) => setScopes(event.target.value)} placeholder="records.read records.write" data-testid="connector-settings-scopes" />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-[13px] text-gray-700">
        <input type="checkbox" checked={exposeDirectly} onChange={(event) => setExposeDirectly(event.target.checked)} />
        Available in other MCP apps
      </label>
      </fieldset>
      {error ? <p className="text-[13px] text-red-600" role="alert">{error}</p> : null}
      <div className="flex items-center justify-end gap-3">
        {lockedReason ? (
          <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-gray-500" data-testid="connector-settings-locked">
            <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
            {lockedReason}
          </p>
        ) : null}
        <DenButton type="submit" size="sm" loading={updateConnection.isPending} disabled={disabled || lockedReason !== null}>{usingPublishedAddresses ? "Save and use these addresses" : "Save changes"}</DenButton>
      </div>
    </form>
    {connection.authType === "oauth" && !connection.manualOAuthEndpoints ? <ConnectorIssuerReview connection={connection} onSaved={onSaved} /> : null}
    <ConfirmDialog
        confirm={confirming ? {
          title: `Change how ${connection.name} connects?`,
          description: "Saved sign-ins and API keys are cleared. Everyone reconnects.",
          action: "Save and sign everyone out",
        } : null}
        onConfirm={save}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** Review changed authorization servers before allowing a fresh sign-in. */
function ConnectorIssuerReview({ connection, onSaved }: { connection: ExternalMcpConnection; onSaved: (message: string) => void }) {
  const review = useReviewMcpIssuer();
  const [preview, setPreview] = useState<McpIssuerReview | null>(null);
  const [issuer, setIssuer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function inspect() {
    setError(null);
    try {
      const result = await review.mutateAsync({ connectionId: connection.id, action: "preview" });
      setPreview(result);
      setIssuer(result.advertisedIssuers.includes(result.currentIssuer ?? "") ? result.currentIssuer ?? "" : result.advertisedIssuers[0] ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sign-in servers did not load. Try again.");
    }
  }

  async function confirm() {
    if (!issuer || !connection.updatedAt) return;
    const result = await review.mutateAsync({ connectionId: connection.id, action: "confirm", expectedUpdatedAt: connection.updatedAt, authorizationServerIssuer: issuer });
    setPreview(null);
    onSaved(result.reconnectionRequired ? "Sign-in server saved. Sign in again to use it." : "The current sign-in server is confirmed.");
  }

  return (
    <details className="group/issuer border-t border-gray-100 px-5 py-3" open={connection.issuerReviewRequired === true}>
      <summary className={DETAILS_SUMMARY_CLASS}><ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform group-open/issuer:rotate-90" aria-hidden />Authorization server selection</summary>
      <div className="mt-3 flex flex-col gap-3">
      {connection.issuerReviewRequired ? <p className="text-[13px] text-gray-600">The sign-in server changed. An admin must review it.</p> : null}
      <DenButton type="button" variant="secondary" size="sm" loading={review.isPending} onClick={() => void inspect()}>Choose authorization server</DenButton>
      {preview ? <>
        <p className="text-[12px] text-gray-500">Saved server: {preview.currentIssuer ?? "None"}</p>
        <Field label="Sign-in server">
          <DenSelect value={issuer} onChange={(event) => setIssuer(event.target.value)}>
            {preview.advertisedIssuers.map((value) => <option key={value} value={value}>{value}</option>)}
          </DenSelect>
        </Field>
        {preview.advertisedIssuers.length === 0 ? <p className="text-[12px] text-gray-500">No sign-in server was found. Check the address and try again.</p> : null}
        <DenButton type="button" size="sm" disabled={!issuer || !connection.updatedAt || review.isPending} onClick={() => setConfirming(true)}>Save authorization server</DenButton>
      </> : null}
      {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
      <ConfirmDialog confirm={confirming ? { title: `Use this sign-in server for ${connection.name}?`, description: `${issuer}. Everyone signs in again; saved sign-ins and OAuth app credentials are cleared if the server changes.`, action: "Save authorization server" } : null} onConfirm={confirm} onClose={() => setConfirming(false)} />
      </div>
    </details>
  );
}
