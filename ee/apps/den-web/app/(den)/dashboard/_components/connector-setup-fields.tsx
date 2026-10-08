"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import type { OAuthAppInput } from "./connector-setup";
import type { ExternalMcpApiKeyAuthScheme } from "./mcp-connections-data";
import { McpCredentialInput } from "./mcp-credential-input";

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
          onChange={(event) => setApiKey(event.target.value)}
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
export function OAuthAppFields({ secretRequired, saving, error, onSave }: {
  secretRequired: boolean;
  saving: boolean;
  error: string | null;
  onSave: (input: OAuthAppInput) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const ready = Boolean(clientId.trim()) && (!secretRequired || Boolean(clientSecret.trim()));
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="setup-oauth-app"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ clientId, clientSecret });
      }}
    >
      <McpCredentialInput
        kind="identifier"
        name="connector-oauth-client-id"
        aria-label="Client ID"
        placeholder="Client ID"
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
        disabled={saving}
        autoFocus
      />
      <div className="flex items-center gap-2">
        <McpCredentialInput
          kind="secret"
          name="connector-oauth-client-secret"
          aria-label="Client secret"
          placeholder={secretRequired ? "Client secret" : "Client secret (optional)"}
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          disabled={saving}
        />
        <DenButton type="submit" className="shrink-0" loading={saving} disabled={!ready}>Save app</DenButton>
      </div>
      {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
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
