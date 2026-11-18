/** @jsxImportSource react */
import { useRef, useState } from "react";
import { ArrowUpRight, Check, Info, Loader2, LockKeyhole, Search, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SecretFieldHandle } from "@/components/secret-field";
import type { DenExternalMcpConnection, DenExternalMcpPreset } from "../../../../app/lib/den";
import { t } from "../../../../i18n";
import type { ProviderSettingsLink } from "../../connections/connection-sign-in-problem";
import { canMemberAuthorizeConnection } from "../../connections/native-provider-connections";
import { isOrgMcpConnectionReady } from "../extension-items";
import { resolveExtensionIconUrl } from "../../../design-system/extension-icon-src";
import { IconImage } from "../../../design-system/icon-image";
import { SecretTextInput } from "../../../design-system/secret-text-input";
import { librarySecretFieldClass } from "./add-library-item-page";
import { LibraryPage } from "./library-page";

/** Den's preset copy leads with what it does; the rest is admin detail. */
export function connectorSummary(preset: Pick<DenExternalMcpPreset, "description">) {
  const first = preset.description.split(/\.\s/)[0]?.trim() ?? "";
  return first.replace(/\.$/, "");
}

export type LibraryConnectorSetupInput = {
  apiKey?: string;
};

/**
 * The provider only accepts an app the organization registers with it (Slack,
 * GitHub), so an admin adds that app in OpenWork Cloud before anyone signs in.
 * A preset with OpenWork's own app signs in like any other.
 */
export function connectorNeedsOrganizationApp(
  preset: Pick<DenExternalMcpPreset, "authType" | "requiresOAuthClient" | "defaultOAuthClientId">,
) {
  return preset.authType === "oauth" && preset.requiresOAuthClient === true && !preset.defaultOAuthClientId;
}

type CatalogConnection = Pick<
  DenExternalMcpConnection,
  "authType" | "credentialMode" | "connected" | "connectedForMe" | "needsReconnect" | "missingFeatures" | "credentialHealth"
>;

/**
 * An organization connector the member signs in to with their own account and
 * has not yet (or must again). Shared connectors and keys stay "Added".
 */
export function catalogConnectionNeedsSignIn(connection: CatalogConnection) {
  return connection.authType === "oauth"
    && connection.credentialMode === "per_member"
    && canMemberAuthorizeConnection(connection)
    && !isOrgMcpConnectionReady(connection);
}

function ConnectorIcon(props: { preset: DenExternalMcpPreset; size?: "sm" | "md" }) {
  const src = resolveExtensionIconUrl({ iconSlug: props.preset.presetId, serviceUrl: props.preset.url });
  const box = props.size === "md" ? "size-10 rounded-xl" : "size-8 rounded-lg";
  return (
    <span aria-hidden="true" className={`flex ${box} shrink-0 items-center justify-center border border-dls-border bg-white`}>
      <IconImage src={src} size={16} fallback={<Server size={15} className="text-dls-secondary" />} />
    </span>
  );
}

/** The organization already has this connector; the member has not signed in to their own account yet. */
export type LibraryConnectorCatalogSignIn = {
  onSignIn: () => void;
  busy: boolean;
  /** The member's last sign-in came back but a setting in the service's app blocks it. */
  problem?: { reason: string; settings: ProviderSettingsLink | null };
  onOpenSettings?: (url: string) => void;
};

/** Every connector the member can add, plus a way to add any other MCP server. */
export function LibraryConnectorCatalogPage(props: {
  presets: DenExternalMcpPreset[];
  addedUrls: Set<string>;
  /** Added connectors the member still signs in to, by URL. Others that are added just say so. */
  signInsByUrl?: ReadonlyMap<string, LibraryConnectorCatalogSignIn>;
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
          const signIn = added ? props.signInsByUrl?.get(preset.url) : undefined;
          return (
            <div key={preset.presetId} data-connector={preset.displayName} className="flex items-center gap-3 border-b border-dls-border/60 py-2.5 last:border-b-0">
              <ConnectorIcon preset={preset} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-dls-text">{preset.displayName}</p>
                {signIn?.problem ? (
                  <p role="status" data-testid="library-connector-problem" className="text-xs text-red-11">{signIn.problem.reason}</p>
                ) : (
                  <p className="truncate text-xs text-dls-secondary">{connectorSummary(preset)}</p>
                )}
              </div>
              {signIn?.problem?.settings && signIn.onOpenSettings ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const url = signIn.problem?.settings?.url;
                    if (url) signIn.onOpenSettings?.(url);
                  }}
                >
                  {signIn.problem.settings.label}
                  <ArrowUpRight size={13} aria-hidden="true" />
                </Button>
              ) : signIn ? (
                <Button
                  size="sm"
                  disabled={signIn.busy}
                  onClick={signIn.onSignIn}
                >
                  {signIn.busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
                  {t("extensions.connector_sign_in_with", { name: preset.displayName })}
                </Button>
              ) : added ? (
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
 * button change with how the connector signs in. A connector that needs the
 * organization's own app is set up by an admin in OpenWork Cloud; members see
 * it locked with who can change that (P4, C5).
 */
export function LibraryConnectorSetupPage(props: {
  preset: DenExternalMcpPreset;
  /** Owners and admins add the organization's app in OpenWork Cloud. */
  canSetUpOrganizationApp: boolean;
  /** Opens OpenWork Cloud's setup for this connector; absent when no Cloud address is known. */
  onSetUpInCloud?: () => void;
  onBack: () => void;
  onCatalog: () => void;
  onSubmit: (input: LibraryConnectorSetupInput) => Promise<void>;
}) {
  const { preset } = props;
  const apiKeyField = useRef<SecretFieldHandle>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsOrganizationApp = connectorNeedsOrganizationApp(preset);
  const lockedForMember = needsOrganizationApp && !props.canSetUpOrganizationApp;
  const signsIn = preset.authType === "oauth";

  const submit = async () => {
    // Each secret is read once here and the field empties.
    const apiKey = preset.authType === "apikey" ? apiKeyField.current?.take() ?? "" : "";
    if (preset.authType === "apikey" && !apiKey.trim()) {
      setError(t("extensions.add_mcp_api_key_required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({
        ...(preset.authType === "apikey" ? { apiKey: apiKey.trim() } : {}),
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
      : needsOrganizationApp
        ? props.canSetUpOrganizationApp
          ? t("extensions.connector_note_org_app_admin", { name: preset.displayName })
          : t("extensions.connector_note_org_app_member", { name: preset.displayName })
        : t("extensions.connector_note_sign_in", { name: preset.displayName });
  const lockedReason = t("extensions.connector_org_app_locked_reason", { name: preset.displayName });

  const primaryAction = needsOrganizationApp
    ? props.canSetUpOrganizationApp
      ? (
        <Button disabled={!props.onSetUpInCloud} onClick={() => props.onSetUpInCloud?.()}>
          {t("extensions.connector_set_up_in_cloud")}
          <ArrowUpRight size={14} aria-hidden="true" />
        </Button>
      )
      : (
        <Button
          variant="outline"
          disabled
          focusableWhenDisabled
          title={lockedReason}
          data-testid="library-connector-locked"
          className="text-muted-foreground"
        >
          <LockKeyhole size={14} aria-hidden="true" />
          {t("extensions.connector_sign_in_with", { name: preset.displayName })}
          <span className="sr-only">. {lockedReason}</span>
        </Button>
      )
    : (
      <Button disabled={busy || (preset.authType === "apikey" && !hasApiKey)} onClick={() => void submit()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : null}
        {signsIn ? t("extensions.connector_sign_in_with", { name: preset.displayName }) : t("extensions.connector_add")}
      </Button>
    );

  return (
    <LibraryPage
      title={t("extensions.connector_setup_title", { name: preset.displayName })}
      subtitle={connectorSummary(preset)}
      icon={<ConnectorIcon preset={preset} size="md" />}
      crumbs={[{ label: t("extensions.connector_catalog_title"), onClick: props.onCatalog }, { label: preset.displayName }]}
      testId="library-connector-setup"
      backDisabled={busy}
      onBack={props.onBack}
      footerNote={needsOrganizationApp ? undefined : t("extensions.add_page_just_me_note")}
      actions={(
        <>
          <Button variant="outline" disabled={busy} onClick={props.onBack}>{t("common.cancel")}</Button>
          {primaryAction}
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
      <div
        data-testid="library-connector-note"
        data-state={needsOrganizationApp ? (lockedForMember ? "locked" : "needs-setup") : undefined}
        className="flex flex-col gap-3 rounded-lg bg-dls-hover px-3.5 py-3"
      >
        {needsOrganizationApp ? (
          <div className="flex items-start gap-2 text-[13px]">
            {lockedForMember
              ? <LockKeyhole size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-dls-secondary" />
              : <Info size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-dls-secondary" />}
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium text-dls-text">{t("extensions.connector_org_app_state")}</p>
              <p className="text-dls-secondary">{note}</p>
            </div>
          </div>
        ) : (
          <p className="flex items-start gap-2 text-[13px] text-dls-secondary">
            <Info size={15} className="mt-0.5 shrink-0" />
            <span>{note}</span>
          </p>
        )}
        {preset.authType === "apikey" ? (
          <SecretTextInput
            id="library-connector-api-key"
            label={t("extensions.add_mcp_api_key_label")}
            disabled={busy}
            handleRef={apiKeyField}
            onValueChange={setHasApiKey}
            className={librarySecretFieldClass}
          />
        ) : null}
      </div>
      {error ? <p role="alert" className="text-[13px] text-red-11">{error}</p> : null}
    </LibraryPage>
  );
}
