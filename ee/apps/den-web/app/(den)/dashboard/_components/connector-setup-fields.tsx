"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import type { OAuthAppInput } from "./connector-setup";
import type { ExternalMcpApiKeyAuthScheme, McpRequirementsDiscovery } from "./mcp-connections-data";
import { ManualOAuthFields } from "./manual-oauth-fields";
import { publishedAddressesUnsaved } from "./manual-oauth-draft";
import { McpCredentialInput } from "./mcp-credential-input";
import { createOAuthAppDraft, validateOAuthAppDraft, withOAuthAppManualDraft, type OAuthAppDraft, type OAuthAppValidationError } from "./oauth-app-draft";

export { createOAuthAppDraft, type OAuthAppDraft } from "./oauth-app-draft";

/** Step two's one field for a server that takes a key. */
export function ApiKeyFields({ name, saving, error, onSave }: {
  name: string;
  saving: boolean;
  error: string | null;
  onSave: (apiKey: string) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="setup-api-key"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(apiKey);
      }}
    >
      <div className="flex items-center gap-2">
        <McpCredentialInput
          kind="secret"
          name="connector-api-key"
          aria-label="API key"
          autoComplete="off"
          data-ph-no-capture
          placeholder={`${name} API key`}
          value={apiKey}
          onChange={setApiKey}
          disabled={saving}
          autoFocus
        />
        <DenButton type="submit" className="shrink-0" loading={saving} disabled={!apiKey.trim()}>Save key</DenButton>
      </div>
      {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
    </form>
  );
}

/** Step two's fields for a server that only accepts a pre-registered OAuth app. */
export function OAuthAppFields({ secretRequired, saving, error, onSave, url, discovery, formId, hideSubmit = false, draft, onDraftChange, setupValidation = false, callbackUrl }: {
  url?: string;
  discovery?: McpRequirementsDiscovery | null;
  secretRequired: boolean;
  saving: boolean;
  error: string | null;
  onSave: (input: OAuthAppInput) => void;
  /** Supply both props to retain the sole draft in the parent across setup choices. */
  draft?: OAuthAppDraft;
  onDraftChange?: (draft: OAuthAppDraft) => void;
  /** Custom connector setup validates a reviewed draft; presets retain their existing form. */
  setupValidation?: boolean;
  /** Exact callback supplied by a backend preset or verified runtime, never inferred here. */
  callbackUrl?: string;
  /** Lets a page footer button submit these fields. */
  formId?: string;
  /** The page footer carries the submit action instead. */
  hideSubmit?: boolean;
}) {
  const [localDraft, setLocalDraft] = useState(() => draft && onDraftChange ? null : createOAuthAppDraft());
  const current = draft && onDraftChange ? draft : localDraft ?? createOAuthAppDraft();
  const [validationError, setValidationError] = useState<OAuthAppValidationError | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const fieldId = useId();
  function change(next: OAuthAppDraft) {
    setValidationError(null);
    if (draft && onDraftChange) onDraftChange(next);
    else setLocalDraft(next);
  }
  const { clientId, clientSecret, manualDraft } = current;
  const manualAddresses = manualDraft.values;
  const usingPublishedAddresses = publishedAddressesUnsaved(manualDraft);
  const hasManual = Boolean(manualAddresses.authorizationEndpoint.trim() && manualAddresses.tokenEndpoint.trim());
  const halfSet = Boolean(manualAddresses.authorizationEndpoint.trim()) !== Boolean(manualAddresses.tokenEndpoint.trim());
  const issuerMismatch = discovery?.warnings.some((warning) => warning.code === "oauth_issuer_mismatch") === true;
  const validationOptions = { secretRequired, setupValidation, url, issuerMismatch };
  const ready = setupValidation ? validateOAuthAppDraft(current, validationOptions).error === null
    : !halfSet && Boolean(clientId.trim()) && (hasManual || !secretRequired || Boolean(clientSecret.trim()));
  const fieldError = (field: OAuthAppValidationError["field"]) => setupValidation && validationError?.field === field
    ? <p id={`${fieldId}-${field}-error`} className="text-[12px] text-red-600" role="alert">{validationError.message}</p> : null;
  return (
    <form
      id={formId}
      className="flex flex-col gap-2"
      data-testid="setup-oauth-app"
      noValidate={setupValidation}
      onSubmit={(event) => {
        event.preventDefault();
        if (setupValidation && saving) return;
        const result = validateOAuthAppDraft(current, validationOptions);
        if (result.error) {
          setValidationError(result.error);
          const names = { clientId: "connector-oauth-client-id", clientSecret: "connector-oauth-client-secret", authorizationEndpoint: "authorizationEndpoint", tokenEndpoint: "tokenEndpoint", trustConfirmed: "trustConfirmed" };
          const control = event.currentTarget.querySelector<HTMLInputElement>(`input[name="${names[result.error.field]}"]`);
          const details = control?.closest("details");
          if (details) details.open = true;
          control?.focus();
          return;
        }
        setValidationError(null);
        onSave(result.input);
      }}
    >
      {setupValidation && callbackUrl ? <div className="flex min-h-10 items-center gap-3 border-b border-gray-100 py-1.5" data-testid="oauth-app-callback">
        <span className="shrink-0 text-[12px] font-medium text-gray-700">Callback URL</span>
        <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-gray-600">{callbackUrl}</code>
        <DenButton type="button" size="xs" variant="secondary" aria-label="Copy callback URL" onClick={() => {
          void navigator.clipboard.writeText(callbackUrl).then(() => setCopyStatus("copied")).catch(() => setCopyStatus("failed"));
        }}>{copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}</DenButton>
      </div> : null}
      {setupValidation ? <label htmlFor={`${fieldId}-client-id`} className="text-[12px] font-medium text-gray-700">Client ID</label> : null}
      <McpCredentialInput
        id={`${fieldId}-client-id`}
        kind="identifier"
        name="connector-oauth-client-id"
        aria-label="Client ID"
        aria-invalid={setupValidation && validationError?.field === "clientId" || undefined}
        aria-describedby={setupValidation && validationError?.field === "clientId" ? `${fieldId}-clientId-error` : undefined}
        placeholder="Client ID"
        value={clientId}
        onChange={(event) => change({ ...current, clientId: event.target.value })}
        disabled={saving}
        autoFocus={!setupValidation}
      />
      {fieldError("clientId")}
      {setupValidation ? <label htmlFor={`${fieldId}-client-secret`} className="text-[12px] font-medium text-gray-700">Client secret{secretRequired ? "" : " (optional)"}</label> : null}
      <div className="flex items-center gap-2">
        <McpCredentialInput
          id={`${fieldId}-client-secret`}
          kind="secret"
          name="connector-oauth-client-secret"
          aria-label="Client secret"
          aria-invalid={setupValidation && validationError?.field === "clientSecret" || undefined}
          aria-describedby={setupValidation && validationError?.field === "clientSecret" ? `${fieldId}-clientSecret-error` : undefined}
          placeholder={secretRequired ? "Client secret" : "Client secret (optional)"}
          value={clientSecret}
          onChange={(clientSecret) => change({ ...current, clientSecret })}
          disabled={saving}
        />
      </div>
      {fieldError("clientSecret")}
      {url ? <ManualOAuthFields url={url} draft={manualDraft} onChange={(manualDraft) => change(withOAuthAppManualDraft(current, manualDraft))} hasClientSecret={Boolean(clientSecret.trim())} disabled={saving} discovery={discovery} setupValidation={setupValidation} trustConfirmed={current.trustConfirmed} onTrustConfirmedChange={(trustConfirmed) => change({ ...current, trustConfirmed })} validationError={setupValidation && validationError && validationError.field !== "clientId" && validationError.field !== "clientSecret" ? validationError : null} /> : null}
      {!url && setupValidation && validationError && validationError.field !== "clientId" && validationError.field !== "clientSecret" ? <p className="text-[12px] text-red-600" role="alert">{validationError.message}</p> : null}
      {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
      {hideSubmit ? null : (
        <div className="flex justify-end pt-1">
          <DenButton type="submit" loading={saving} disabled={!ready}>{usingPublishedAddresses ? "Save and use these addresses" : "Save changes"}</DenButton>
        </div>
      )}
    </form>
  );
}

/** Rarely changed key transport; collapsed so the default path is only the decision that matters. */
export function ApiKeySchemeAdvanced({ value, onChange, disabled, testId }: {
  value: ExternalMcpApiKeyAuthScheme;
  onChange: (value: ExternalMcpApiKeyAuthScheme) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-gray-600 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 text-gray-400 transition-transform group-open:rotate-90" aria-hidden />
        Advanced
      </summary>
      <label className="mt-2 flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-gray-700">Authorization scheme</span>
        <DenSelect
          value={value}
          disabled={disabled}
          data-testid={testId}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "bearer" || next === "token") onChange(next);
          }}
        >
          <option value="bearer">Bearer</option>
          <option value="token">Token</option>
        </DenSelect>
      </label>
    </details>
  );
}
