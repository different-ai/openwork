"use client";

import { type ReactNode, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import { DenInput } from "../../_components/ui/input";
import { ConfirmDialog } from "./item-list";
import { McpCredentialInput } from "./mcp-credential-input";
import { type ExternalMcpAuthType, type ExternalMcpCredentialMode, type ExternalMcpConnection, type McpIssuerReview, type UpdateMcpConnectionInput, useReviewMcpIssuer, useUpdateMcpConnection } from "./mcp-connections-data";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

/** Rename a connector, move its address, rotate its key, or replace its OAuth app, in place on its page. */
export function ConnectorSettingsForm({ connection, onSaved }: { connection: ExternalMcpConnection; onSaved: (message: string) => void }) {
  const updateConnection = useUpdateMcpConnection();
  const [name, setName] = useState(connection.name);
  const [url, setUrl] = useState(connection.url);
  const [authType, setAuthType] = useState<ExternalMcpAuthType>(connection.authType);
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>(connection.credentialMode);
  const [showOAuthApp, setShowOAuthApp] = useState(Boolean(connection.oauthClientId) || connection.oauthClientRequired === true);
  const [scopes, setScopes] = useState((connection.requestedScopes ?? []).join(" "));
  const [exposeDirectly, setExposeDirectly] = useState(connection.exposeDirectly);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState(connection.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managedByPlugin = connection.identityManagedBy.length > 0;
  const usesKey = authType === "apikey";
  const usesOAuthApp = authType === "oauth" && showOAuthApp;
  const chosenMode = authType === "oauth" ? credentialMode : "shared";
  const identityChanged = url.trim() !== connection.url || authType !== connection.authType || chosenMode !== connection.credentialMode;
  const requestedScopes = [...new Set(scopes.split(/[\s,]+/).filter(Boolean))];
  const scopesChanged = requestedScopes.join(" ") !== (connection.requestedScopes ?? []).join(" ");
  const clientChanged = usesOAuthApp && (clientId.trim() !== (connection.oauthClientId ?? "") || Boolean(clientSecret.trim()));
  const changed = name.trim() !== connection.name || identityChanged || Boolean(apiKey.trim()) || clientChanged || scopesChanged || exposeDirectly !== connection.exposeDirectly;
  const keyRequired = usesKey && identityChanged && !apiKey.trim();
  const disabled = !changed || !name.trim() || !url.trim() || keyRequired || (clientChanged && !clientId.trim()) || !connection.updatedAt;

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
      ...(usesKey && !managedByPlugin && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(clientChanged && clientId.trim()
        ? { oauthClient: { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) } }
        : {}),
      access: connection.access ?? { orgWide: false, memberIds: [], teamIds: [] },
    };
    try {
      const updated = await updateConnection.mutateAsync(input);
      setApiKey("");
      setClientSecret("");
      onSaved(updated.reconnectionRequired ? `${updated.name} is saved. Sign in again to use it.` : `${updated.name} is saved.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    }
  }

  return (
    <>
    <form
      className="flex flex-col gap-3 px-5 py-4"
      data-testid="connector-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (identityChanged) setConfirming(true);
        else void save();
      }}
    >
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
        <DenSelect value={chosenMode} disabled={managedByPlugin || authType !== "oauth"} onChange={(event) => {
          const value = event.target.value;
          if (value === "per_member" || value === "shared") setCredentialMode(value);
        }}>
          <option value="per_member">Each person signs in</option>
          <option value="shared">One account for everyone</option>
        </DenSelect>
      </Field>
      {authType !== "oauth" ? <p className="text-[12px] text-gray-500">This connection is shared; nobody signs in individually.</p> : null}
      {authType === "oauth" && !showOAuthApp ? <DenButton type="button" variant="secondary" size="sm" onClick={() => setShowOAuthApp(true)}>Add OAuth app</DenButton> : null}
      {usesKey && !managedByPlugin ? (
        <Field label={keyRequired ? "New API key" : "New API key (optional)"}>
          <McpCredentialInput kind="secret" name="connector-settings-api-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Leave empty to keep the saved key" data-testid="connector-settings-api-key" />
        </Field>
      ) : null}
      {usesOAuthApp ? (
        <>
          <Field label="OAuth client ID">
            <McpCredentialInput kind="identifier" name="connector-settings-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID" />
          </Field>
          <Field label="New client secret (optional)">
            <McpCredentialInput kind="secret" name="connector-settings-client-secret" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Leave empty to keep the saved secret" />
          </Field>
        </>
      ) : null}
      {authType === "oauth" ? (
        <Field label="Requested OAuth scopes">
          <DenInput value={scopes} disabled={managedByPlugin} onChange={(event) => setScopes(event.target.value)} placeholder="records.read records.write" data-testid="connector-settings-scopes" />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-[13px] text-gray-700">
        <input type="checkbox" checked={exposeDirectly} onChange={(event) => setExposeDirectly(event.target.checked)} />
        Available in other MCP apps
      </label>
      {error ? <p className="text-[13px] text-red-600" role="alert">{error}</p> : null}
      <div className="flex justify-end">
        <DenButton type="submit" size="sm" loading={updateConnection.isPending} disabled={disabled}>Save changes</DenButton>
      </div>
    </form>
    {connection.authType === "oauth" ? <ConnectorIssuerReview connection={connection} onSaved={onSaved} /> : null}
    <ConfirmDialog
        confirm={confirming ? {
          title: `Change how ${connection.name} connects?`,
          description: "Everyone signed in to it signs in again.",
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
    <div className="flex flex-col gap-3 border-t border-gray-100 px-5 py-4">
      {connection.issuerReviewRequired ? <p className="text-[13px] text-gray-600">The sign-in server changed. An admin must review it.</p> : null}
      <DenButton type="button" variant="secondary" size="sm" loading={review.isPending} onClick={() => void inspect()}>Review sign-in server</DenButton>
      {preview ? <>
        <p className="text-[12px] text-gray-500">Saved server: {preview.currentIssuer ?? "None"}</p>
        <Field label="Sign-in server">
          <DenSelect value={issuer} onChange={(event) => setIssuer(event.target.value)}>
            {preview.advertisedIssuers.map((value) => <option key={value} value={value}>{value}</option>)}
          </DenSelect>
        </Field>
        {preview.advertisedIssuers.length === 0 ? <p className="text-[12px] text-gray-500">No sign-in server was found. Check the address and try again.</p> : null}
        <DenButton type="button" size="sm" disabled={!issuer || !connection.updatedAt || review.isPending} onClick={() => setConfirming(true)}>Save sign-in server</DenButton>
      </> : null}
      {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
      <ConfirmDialog confirm={confirming ? { title: `Use this sign-in server for ${connection.name}?`, description: `${issuer}. Everyone signs in again; saved sign-ins and OAuth app credentials are cleared if the server changes.`, action: "Save sign-in server" } : null} onConfirm={confirm} onClose={() => setConfirming(false)} />
    </div>
  );
}
