/** @jsxImportSource react */
import { useState } from "react";
import { Check, Info, Loader2, Search, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DenExternalMcpPreset } from "../../../../app/lib/den";
import { t } from "../../../../i18n";
import { resolveExtensionIconUrl } from "../../../design-system/extension-icon-src";
import { IconImage } from "../../../design-system/icon-image";
import { TextInput } from "../../../design-system/text-input";
import { libraryFieldClass } from "./add-library-item-page";
import { LibraryPage } from "./library-page";

/** Den's preset copy leads with what it does; the rest is admin detail. */
export function connectorSummary(preset: Pick<DenExternalMcpPreset, "description">) {
  const first = preset.description.split(/\.\s/)[0]?.trim() ?? "";
  return first.replace(/\.$/, "");
}

export type LibraryConnectorSetupInput = {
  apiKey?: string;
  oauthClient?: { clientId: string; clientSecret?: string };
};

function ConnectorIcon(props: { preset: DenExternalMcpPreset; size?: "sm" | "md" }) {
  const src = resolveExtensionIconUrl({ iconSlug: props.preset.presetId, serviceUrl: props.preset.url });
  const box = props.size === "md" ? "size-10 rounded-xl" : "size-8 rounded-lg";
  return (
    <span aria-hidden="true" className={`flex ${box} shrink-0 items-center justify-center border border-dls-border bg-white`}>
      <IconImage src={src} size={16} fallback={<Server size={15} className="text-dls-secondary" />} />
    </span>
  );
}

/** Every connector the member can add, plus a way to add any other MCP server. */
export function LibraryConnectorCatalogPage(props: {
  presets: DenExternalMcpPreset[];
  addedUrls: Set<string>;
  onBack: () => void;
  onPick: (preset: DenExternalMcpPreset) => void;
  onSomethingElse: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = props.presets.filter((preset) =>
    !needle || `${preset.displayName} ${preset.description}`.toLowerCase().includes(needle));
  return (
    <LibraryPage
      title={t("extensions.connector_catalog_title")}
      crumbs={[{ label: t("extensions.connector_catalog_title") }]}
      testId="library-connector-catalog"
      onBack={props.onBack}
    >
      <label className="relative block">
        <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dls-secondary" />
        <input
          type="search"
          value={query}
          aria-label={t("extensions.connector_catalog_filter")}
          placeholder={t("extensions.connector_catalog_filter")}
          className="h-9 w-full rounded-lg border border-dls-border bg-background pr-3 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="flex flex-col">
        {visible.map((preset) => {
          const added = props.addedUrls.has(preset.url);
          return (
            <div key={preset.presetId} data-connector={preset.displayName} className="flex items-center gap-3 border-b border-dls-border/60 py-2.5 last:border-b-0">
              <ConnectorIcon preset={preset} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-dls-text">{preset.displayName}</p>
                <p className="truncate text-xs text-dls-secondary">{connectorSummary(preset)}</p>
              </div>
              {added ? (
                <span className="flex items-center gap-1 text-xs text-dls-secondary"><Check size={12} />{t("extensions.connector_added")}</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t("extensions.connector_add_named", { name: preset.displayName })}
                  onClick={() => props.onPick(preset)}
                >
                  {t("extensions.connector_add")}
                </Button>
              )}
            </div>
          );
        })}
        {visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-dls-secondary">{t("extensions.connector_catalog_empty")}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-dls-border px-3 py-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dls-border text-dls-secondary">
          <Server size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-dls-text">{t("extensions.connector_something_else_title")}</p>
          <p className="text-xs text-dls-secondary">{t("extensions.connector_something_else_hint")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={props.onSomethingElse}>{t("extensions.connector_add_mcp")}</Button>
      </div>
    </LibraryPage>
  );
}

/**
 * The one setup page every listed connector shares. Only the grey box and the
 * button change with how the connector signs in.
 */
export function LibraryConnectorSetupPage(props: {
  preset: DenExternalMcpPreset;
  onBack: () => void;
  onCatalog: () => void;
  onSubmit: (input: LibraryConnectorSetupInput) => Promise<void>;
}) {
  const { preset } = props;
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsCodes = preset.authType === "oauth" && preset.requiresOAuthClient === true;
  const signsIn = preset.authType === "oauth";

  const submit = async () => {
    if (preset.authType === "apikey" && !apiKey.trim()) {
      setError(t("extensions.add_mcp_api_key_required"));
      return;
    }
    if (needsCodes && !clientId.trim()) {
      setError(t("extensions.connector_codes_required", { name: preset.displayName }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({
        ...(preset.authType === "apikey" ? { apiKey: apiKey.trim() } : {}),
        ...(needsCodes ? { oauthClient: { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) } } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error && cause.message.trim() ? cause.message : t("common.something_went_wrong"));
      setBusy(false);
    }
  };

  const note = preset.authType === "apikey"
    ? t("extensions.connector_note_key")
    : preset.authType === "none"
      ? t("extensions.connector_note_none")
      : needsCodes
        ? t("extensions.connector_note_codes", { name: preset.displayName })
        : t("extensions.connector_note_sign_in", { name: preset.displayName });

  return (
    <LibraryPage
      title={t("extensions.connector_setup_title", { name: preset.displayName })}
      subtitle={connectorSummary(preset)}
      icon={<ConnectorIcon preset={preset} size="md" />}
      crumbs={[{ label: t("extensions.connector_catalog_title"), onClick: props.onCatalog }, { label: preset.displayName }]}
      testId="library-connector-setup"
      backDisabled={busy}
      onBack={props.onBack}
      footerNote={t("extensions.add_page_just_me_note")}
      actions={(
        <>
          <Button variant="outline" disabled={busy} onClick={props.onBack}>{t("common.cancel")}</Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {signsIn ? t("extensions.connector_sign_in_with", { name: preset.displayName }) : t("extensions.connector_add")}
          </Button>
        </>
      )}
    >
      <section aria-labelledby="library-connector-can-do">
        <h2 id="library-connector-can-do" className="mb-2 text-sm font-medium text-dls-text">{t("extensions.connector_can_do")}</h2>
        <ul className="flex flex-col gap-1.5 text-[13px] text-dls-secondary">
          <li className="flex items-center gap-2"><Check size={13} className="shrink-0" />{t("extensions.connector_can_read", { summary: connectorSummary(preset).toLowerCase() })}</li>
          <li className="flex items-center gap-2"><Check size={13} className="shrink-0" />{t("extensions.connector_can_act")}</li>
        </ul>
      </section>
      <div data-testid="library-connector-note" className="flex flex-col gap-3 rounded-lg bg-dls-hover px-3.5 py-3">
        <p className="flex items-start gap-2 text-[13px] text-dls-secondary">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>{note}</span>
        </p>
        {preset.authType === "apikey" ? (
          <TextInput
            label={t("extensions.add_mcp_api_key_label")}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={busy}
            className={libraryFieldClass}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
        ) : null}
        {needsCodes ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label={t("extensions.add_mcp_oauth_client_id_label")}
              autoComplete="off"
              value={clientId}
              disabled={busy}
              className={libraryFieldClass}
              onChange={(event) => setClientId(event.currentTarget.value)}
            />
            <TextInput
              label={t("extensions.add_mcp_oauth_client_secret_label")}
              type="password"
              autoComplete="new-password"
              value={clientSecret}
              disabled={busy}
              className={libraryFieldClass}
              onChange={(event) => setClientSecret(event.currentTarget.value)}
            />
          </div>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-[13px] text-red-11">{error}</p> : null}
    </LibraryPage>
  );
}
