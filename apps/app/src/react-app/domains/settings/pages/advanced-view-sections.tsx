/** @jsxImportSource react */
import { useState, type ComponentProps, type ReactNode } from "react";
import { CircleAlert, Cpu, Database, Info, RefreshCcw, Server } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { OpenworkCloudMcpHealth, OpenworkRuntimeConfigStatus, OpenworkServerStatus } from "@/app/lib/openwork-server";
import { sanitizeCloudMcpHealthDiagnostic, sanitizeDiagnosticRecord } from "@/app/lib/diagnostic-sanitizer";
import {
  DEFAULT_DEN_API_BASE_URL,
  DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "@/app/lib/den";
import {
  describeCloudMcpTarget,
  describeDenEndpointSource,
  type DenEndpointSource,
} from "@/app/lib/den-endpoint-sources";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { ControlPlaneUrlEditor } from "../cloud/control-plane-url-editor";
import {
  displayCustomControlPlaneUrl,
  isValidControlPlaneUrl,
} from "../cloud/control-plane-url";
import {
  SettingsInset,
  SettingsNotice,
  SettingsStatusBadge,
} from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "../settings-layout";

type SettingsTone = ComponentProps<typeof SettingsStatusBadge>["tone"];

const DESKTOP_BOOTSTRAP_PATH_HINT = "~/.config/openwork/desktop-bootstrap.json";

function sourceBadgeLabel(source: DenEndpointSource): string {
  switch (source) {
    case "custom":
      return t("settings.server_endpoints_source_custom");
    case "bootstrap":
      return t("settings.server_endpoints_source_bootstrap");
    case "default":
      return t("settings.server_endpoints_source_default");
  }
}

function sourceBadgeClass(source: DenEndpointSource): string {
  switch (source) {
    case "custom":
      return "border-blue-7/40 bg-blue-3 text-blue-11";
    case "bootstrap":
      return "border-amber-7/40 bg-amber-3 text-amber-11";
    case "default":
      return "border-gray-7/50 bg-gray-3 text-gray-11";
  }
}

function EndpointSourceBadge(props: { source: DenEndpointSource }) {
  return (
    <Badge variant="outline" className={sourceBadgeClass(props.source)}>
      {sourceBadgeLabel(props.source)}
    </Badge>
  );
}

function EndpointWarningBadge(props: { children: ReactNode }) {
  return (
    <Badge variant="outline" className="border-amber-7/40 bg-amber-3 text-amber-11">
      {props.children}
    </Badge>
  );
}

function EndpointRow(props: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="grid gap-1 rounded-xl border border-gray-6/50 bg-gray-1/60 p-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-9">
        {props.label}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="truncate font-mono text-xs text-gray-12" title={props.value}>
          {props.value}
        </div>
        {props.children ? <div className="flex flex-wrap gap-1.5">{props.children}</div> : null}
      </div>
    </div>
  );
}

function bootstrapValueWhenNotDefault(value: string, buildDefault: string): string | null {
  const fallback = describeDenEndpointSource({
    storedValue: null,
    bootstrapValue: null,
    buildDefault,
  });
  return value === fallback.effective ? null : value;
}

function ServerEndpointsCard(props: { cloudMcpUrl: string | null }) {
  const settings = readDenSettings();
  const effectiveApiBaseUrl = settings.apiBaseUrl ?? DEFAULT_DEN_API_BASE_URL;
  const bootstrap = readDenBootstrapConfig();
  const organizationServer = describeDenEndpointSource({
    storedValue: null,
    bootstrapValue: bootstrapValueWhenNotDefault(bootstrap.baseUrl, DEFAULT_DEN_BASE_URL),
    buildDefault: DEFAULT_DEN_BASE_URL,
  });
  const apiEndpoint = describeDenEndpointSource({
    storedValue: null,
    bootstrapValue: bootstrapValueWhenNotDefault(bootstrap.apiBaseUrl, DEFAULT_DEN_API_BASE_URL),
    buildDefault: DEFAULT_DEN_API_BASE_URL,
  });
  const cloudMcp = describeCloudMcpTarget({
    mcpUrl: props.cloudMcpUrl,
    effectiveApiBaseUrl,
  });
  const hasBootstrapSource = organizationServer.source === "bootstrap" || apiEndpoint.source === "bootstrap";

  return (
    <SettingsInset className="space-y-3 bg-gray-1/40">
      <div className="space-y-1">
        <div className="text-sm font-medium text-gray-12">{t("settings.server_endpoints_title")}</div>
        <div className="text-xs text-gray-9">{t("settings.server_endpoints_desc")}</div>
      </div>

      <div className="space-y-2">
        <EndpointRow label={t("settings.server_endpoints_org")} value={settings.baseUrl}>
          <EndpointSourceBadge source={organizationServer.source} />
        </EndpointRow>
        <EndpointRow label={t("settings.server_endpoints_api")} value={effectiveApiBaseUrl}>
          <EndpointSourceBadge source={apiEndpoint.source} />
        </EndpointRow>
        <EndpointRow
          label={t("settings.server_endpoints_cloud_mcp")}
          value={cloudMcp.url ?? t("settings.server_endpoints_not_configured")}
        >
          {cloudMcp.url && cloudMcp.isLocalhost ? (
            <EndpointWarningBadge>{t("settings.server_endpoints_local_dev")}</EndpointWarningBadge>
          ) : null}
          {cloudMcp.url && !cloudMcp.matchesApi ? (
            <EndpointWarningBadge>{t("settings.server_endpoints_mismatch")}</EndpointWarningBadge>
          ) : null}
        </EndpointRow>
      </div>

      {hasBootstrapSource ? (
        <div className="text-[11px] text-amber-11">
          {t("settings.server_endpoints_bootstrap_hint", { path: DESKTOP_BOOTSTRAP_PATH_HINT })}
        </div>
      ) : null}
    </SettingsInset>
  );
}

interface AdvancedOrganizationServerSectionProps {
  authBusy: boolean;
  baseUrl: string;
  baseUrlBusy: boolean;
  baseUrlDraft: string;
  baseUrlError: string | null;
  onApplyBaseUrl: () => void | Promise<void>;
  onBaseUrlDraftChange: (value: string) => void;
  onClearServerConfiguration: () => void | Promise<void>;
  onResetBaseUrlToDefault: () => void | Promise<void>;
  sessionBusy: boolean;
  cloudMcpUrl: string | null;
}

export function AdvancedOrganizationServerSection(props: AdvancedOrganizationServerSectionProps) {
  const [clearConfirming, setClearConfirming] = useState(false);
  const controlsDisabled = [props.authBusy, props.baseUrlBusy, props.sessionBusy].some(Boolean);
  const customUrl = displayCustomControlPlaneUrl(props.baseUrlDraft);
  const currentUrl = displayCustomControlPlaneUrl(props.baseUrl);
  const clearServerConfiguration = () => {
    if (!clearConfirming) {
      setClearConfirming(true);
      return;
    }
    setClearConfirming(false);
    void props.onClearServerConfiguration();
  };

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.organization_server_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.organization_server_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <ControlPlaneUrlEditor
          disabled={controlsDisabled}
          hint={t("settings.organization_server_url_hint")}
          label={t("settings.organization_server_url_label")}
          onReset={props.onResetBaseUrlToDefault}
          onSave={props.onApplyBaseUrl}
          onValueChange={props.onBaseUrlDraftChange}
          placeholder={DEFAULT_DEN_BASE_URL}
          resetLabel={t("common.reset")}
          saveDisabled={!isValidControlPlaneUrl(customUrl)}
          saveLabel={t("common.save")}
          value={customUrl}
        />
        <LayoutSectionItemFootnote>
          {currentUrl
            ? t("settings.organization_server_current", { url: currentUrl })
            : t("settings.organization_server_default")}
        </LayoutSectionItemFootnote>
        {isDesktopRuntime() ? <ServerEndpointsCard cloudMcpUrl={props.cloudMcpUrl} /> : null}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-9">
          <Button
            variant={clearConfirming ? "destructive" : "outline"}
            size="sm"
            onClick={clearServerConfiguration}
            disabled={controlsDisabled}
          >
            {clearConfirming
              ? t("den.cloud_control_plane_clear_confirm")
              : t("den.cloud_control_plane_clear")}
          </Button>
          <span>
            {clearConfirming
              ? t("den.cloud_control_plane_clear_confirm_hint")
              : t("den.cloud_control_plane_clear_hint")}
          </span>
        </div>
        {props.baseUrlError ? <SettingsNotice tone="error">{props.baseUrlError}</SettingsNotice> : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}

interface RuntimeStatusCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  statusLabel: string;
  tone: SettingsTone;
  detailLines?: string[];
}

function RuntimeStatusCard(props: RuntimeStatusCardProps) {
  return (
    <SettingsInset className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
          {props.icon}
        </div>
        <div>
          <div className="text-sm font-medium text-gray-12">{props.title}</div>
          <div className="text-xs text-gray-9">{props.description}</div>
        </div>
      </div>
      <SettingsStatusBadge className="inline-flex min-h-0 justify-start px-0 py-0" tone={props.tone} label={props.statusLabel} />
      {props.detailLines?.length ? (
        <div className="space-y-1 border-t border-gray-6/50 pt-2 text-[11px] text-gray-9">
          {props.detailLines.map((line) => (
            <div key={line} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </SettingsInset>
  );
}

interface AdvancedRuntimeSectionProps {
  clientStatusLabel: string;
  clientTone: SettingsTone;
  clientDetailLines: string[];
  openworkStatusLabel: string;
  openworkTone: SettingsTone;
  openworkDetailLines: string[];
}

export function AdvancedRuntimeSection(props: AdvancedRuntimeSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.runtime_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.runtime_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <RuntimeStatusCard
          icon={<Cpu size={18} />}
          title={t("settings.opencode_engine_label")}
          description={t("settings.opencode_engine_desc")}
          statusLabel={props.clientStatusLabel}
          tone={props.clientTone}
          detailLines={props.clientDetailLines}
        />
        <RuntimeStatusCard
          icon={<Server size={18} />}
          title={t("settings.openwork_server_label")}
          description={t("settings.openwork_server_desc")}
          statusLabel={props.openworkStatusLabel}
          tone={props.openworkTone}
          detailLines={props.openworkDetailLines}
        />
      </div>
    </LayoutSection>
  );
}

function DiagnosticRow(props: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-lg border border-gray-6 bg-gray-2/50 p-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-8">{props.label}</div>
      <div className="min-w-0 break-all font-mono text-[11px] text-gray-12">{props.value}</div>
    </div>
  );
}

function joinList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function formatMaybe(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value);
}

function formatMetadataRecord(value: Record<string, string | number | boolean | null> | null | undefined): string {
  if (!value || Object.keys(value).length === 0) return "none";
  return Object.entries(value).map(([key, nested]) => `${key}=${formatMaybe(nested)}`).join(", ");
}

function formatSupportedFeatures(features: OpenworkCloudMcpHealth["compatibility"]["supportedFeatures"]): string {
  return Object.entries(features).map(([key, enabled]) => `${key}:${enabled ? "yes" : "no"}`).join(", ");
}

function formatPluginHashes(hashes: OpenworkCloudMcpHealth["compatibility"]["pluginFileHashes"]): string {
  if (hashes.length === 0) return "none";
  return hashes.map((hash) => `${hash.name}=${hash.sha256 ? hash.sha256.slice(0, 12) : `unavailable${hash.error ? ` (${hash.error})` : ""}`}`).join(", ");
}

function formatMcpToolExposure(input: { checked: boolean; includesMcpTools: boolean | null; present: string[]; missing: string[]; limitation?: string }): string {
  if (!input.checked) return "not checked";
  const includes = input.includesMcpTools === null ? "unknown" : input.includesMcpTools ? "yes" : "no";
  return `includes MCP tools: ${includes}; present ${joinList(input.present)}; missing ${joinList(input.missing)}${input.limitation ? `; limitation: ${input.limitation}` : ""}`;
}

interface AdvancedCloudMcpDiagnosticsSectionProps {
  cloudMcpHealth: OpenworkCloudMcpHealth | null;
  onRefresh: () => Promise<OpenworkCloudMcpHealth | null>;
}

export function AdvancedCloudMcpDiagnosticsSection(props: AdvancedCloudMcpDiagnosticsSectionProps) {
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const safeHealth = sanitizeCloudMcpHealthDiagnostic(props.cloudMcpHealth);
  const projection = props.cloudMcpHealth?.tools.providerProjection;
  const compatibility = props.cloudMcpHealth?.compatibility;

  const refresh = async () => {
    setBusy(true);
    setCopyStatus(null);
    try {
      await props.onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const payload = JSON.stringify({ cloudMcpHealth: safeHealth }, null, 2);
    await navigator.clipboard.writeText(payload);
    setCopyStatus("Copied sanitized Cloud diagnostic.");
  };

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>Agent access diagnostics</LayoutSectionTitle>
        <LayoutSectionDescription>
          Technical details for OpenWork Cloud MCP delivery. Tokens and Authorization headers are redacted before display or copy.
        </LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>OpenWork Cloud MCP health</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            Use this when support needs exact runtime state. The main Connect card stays user-facing.
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
              <RefreshCcw size={14} className={busy ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()} disabled={!props.cloudMcpHealth}>
              Copy sanitized diagnostic
            </Button>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        {copyStatus ? <SettingsNotice>{copyStatus}</SettingsNotice> : null}
        {props.cloudMcpHealth ? (
          <div className="space-y-2 rounded-xl border border-gray-6 bg-gray-1/60 p-3">
            <div className="grid gap-2">
              <DiagnosticRow label="Active workspace" value={`${props.cloudMcpHealth.workspace.id} (${props.cloudMcpHealth.workspace.directory ?? "no directory"})`} />
              <DiagnosticRow label="Desired revision" value={props.cloudMcpHealth.desired.revision ?? "none"} />
              <DiagnosticRow label="Applied revision" value={props.cloudMcpHealth.delivery.appliedRevision ?? "none"} />
              <DiagnosticRow label="Delivery" value={`${props.cloudMcpHealth.delivery.state}${props.cloudMcpHealth.delivery.trigger ? ` / ${props.cloudMcpHealth.delivery.trigger}` : ""}`} />
              <DiagnosticRow label="Engine status" value={props.cloudMcpHealth.engine.status} />
              <DiagnosticRow label="Provider/model" value={projection?.checked ? `${projection.provider ?? "unknown"}/${projection.model ?? "unknown"}; source ${projection.source ?? "unknown"}; tool calling ${formatMaybe(projection.toolCalling)}; present ${joinList(projection.present)}; missing ${joinList(projection.missing)}${projection.limitation ? `; limitation: ${projection.limitation}` : ""}` : "not checked"} />
              <DiagnosticRow label="Cloud tools" value={`derived present ${joinList(props.cloudMcpHealth.tools.present)}; missing ${joinList(props.cloudMcpHealth.tools.missing)}`} />
              <DiagnosticRow label="Direct tools/list" value={`present ${joinList(props.cloudMcpHealth.tools.direct.present)}; missing ${joinList(props.cloudMcpHealth.tools.direct.missing)}`} />
              <DiagnosticRow label="Plugin canaries" value={`present ${joinList(props.cloudMcpHealth.pluginCanaries.present)}; missing ${joinList(props.cloudMcpHealth.pluginCanaries.missing)}`} />
              <DiagnosticRow label="Safe capabilities" value={`schema v${props.cloudMcpHealth.schemaVersion}; connect catalog ${props.cloudMcpHealth.connectCatalogEnabled ? "enabled" : "disabled"}`} />
              {compatibility ? (
                <>
                  <DiagnosticRow label="OpenWork versions" value={`server ${formatMaybe(compatibility.openwork.serverVersion)}; app ${formatMetadataRecord(compatibility.openwork.app)}`} />
                  <DiagnosticRow label="OpenCode compatibility" value={`expected ${formatMaybe(compatibility.opencode.expectedVersion)}; actual ${formatMaybe(compatibility.opencode.actualVersion)}; probe ${compatibility.opencode.probe}`} />
                  <DiagnosticRow label="Feature probes" value={formatSupportedFeatures(compatibility.supportedFeatures)} />
                  <DiagnosticRow label="Experimental tool IDs" value={formatMcpToolExposure(compatibility.experimentalToolIds)} />
                  <DiagnosticRow label="Experimental provider tools" value={formatMcpToolExposure(compatibility.experimentalProviderTools)} />
                  <DiagnosticRow label="Plugin hashes" value={formatPluginHashes(compatibility.pluginFileHashes)} />
                </>
              ) : null}
              <DiagnosticRow label="Live verification" value={props.cloudMcpHealth.checkedAt} />
            </div>
            <details className="rounded-lg bg-gray-3 p-2">
              <summary className="cursor-pointer text-[11px] font-medium text-gray-11">Show sanitized health JSON</summary>
              <pre className="mt-2 max-h-72 overflow-auto font-mono text-[11px] text-gray-11">
                {JSON.stringify(safeHealth, null, 2)}
              </pre>
            </details>
          </div>
        ) : (
          <SettingsNotice>No Cloud MCP health has been loaded for this workspace yet.</SettingsNotice>
        )}
      </LayoutSectionItem>
    </LayoutSection>
  );
}

interface AdvancedRuntimeMigrationSectionProps {
  busy: boolean;
  canMigrate: boolean;
  migrationBusy: boolean;
  migrationStatus: string | null;
  configStatus: OpenworkRuntimeConfigStatus | null;
  configStatusBusy: boolean;
  configStatusError: string | null;
  onRefresh: () => Promise<void>;
  onMigrate: () => Promise<void>;
}

function formatKeys(keys: string[]) {
  return keys.length ? keys.join(", ") : "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizedConfig(config: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticRecord(config);
}

function countRecord(value: unknown) {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function countArray(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function providerModelCount(config: Record<string, unknown>) {
  const providers = isRecord(config.provider) ? config.provider : {};
  return Object.values(providers).reduce<number>((total, provider) => {
    if (!isRecord(provider)) return total;
    return total + countRecord(provider.models);
  }, 0);
}

function RuntimeConfigSummary(props: { config: Record<string, unknown> }) {
  const config = props.config;
  const providers = countRecord(config.provider);
  const models = providerModelCount(config);
  const agents = countRecord(config.agent);
  const plugins = countArray(config.plugin);
  const mcps = countRecord(config.mcp);
  const permissions = countRecord(config.permission);
  const disabledProviders = countArray(config.disabled_providers);
  const defaultAgent = typeof config.default_agent === "string" ? config.default_agent : "not set";

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">Default agent</div>
        <div className="mt-1 truncate font-mono text-[11px] text-gray-12" title={defaultAgent}>{defaultAgent}</div>
      </div>
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">Providers / models</div>
        <div className="mt-1 font-mono text-[11px] text-gray-12">{providers} providers, {models} models</div>
      </div>
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">Agents / plugins</div>
        <div className="mt-1 font-mono text-[11px] text-gray-12">{agents} agents, {plugins} plugins</div>
      </div>
      <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-8">MCP / permissions</div>
        <div className="mt-1 font-mono text-[11px] text-gray-12">{mcps} MCPs, {permissions} permission keys</div>
      </div>
      {disabledProviders ? (
        <div className="rounded-lg border border-gray-6 bg-gray-2/60 p-2 sm:col-span-2 lg:col-span-4">
          <div className="text-[10px] uppercase tracking-wide text-gray-8">Disabled providers</div>
          <div className="mt-1 font-mono text-[11px] text-gray-12">{disabledProviders}</div>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeConfigSourceBlock(props: {
  title: string;
  description: string;
  path?: string;
  exists?: boolean;
  keys: string[];
  config: Record<string, unknown>;
}) {
  const safeConfig = sanitizedConfig(props.config);
  return (
    <div className="space-y-2 rounded-xl border border-gray-6 bg-gray-1/70 p-3">
      <div>
        <div className="font-medium text-gray-12">{props.title}</div>
        <div className="text-[11px] text-gray-9">{props.description}</div>
        {props.path ? <div className="mt-1 break-all font-mono text-[11px] text-gray-8">{props.path}</div> : null}
        {props.exists !== undefined ? <div className="text-[11px] text-gray-9">{props.exists ? "Found" : "Not found"}</div> : null}
        <div className="text-[11px] text-gray-9">Keys: {formatKeys(props.keys)}</div>
      </div>
      <RuntimeConfigSummary config={safeConfig} />
      <details className="rounded-lg bg-gray-3 p-2">
        <summary className="cursor-pointer text-[11px] font-medium text-gray-11">Show raw JSON</summary>
        <pre className="mt-2 max-h-56 overflow-auto font-mono text-[11px] text-gray-11">
          {JSON.stringify(safeConfig, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function AdvancedRuntimeMigrationSection(props: AdvancedRuntimeMigrationSectionProps) {
  const effectiveRuntimeConfig = props.configStatus
    ? sanitizedConfig(props.configStatus.effectiveRuntime ?? props.configStatus.runtime)
    : null;
  const runtimeConfig = props.configStatus ? sanitizedConfig(props.configStatus.runtime) : null;
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>OpenCode config sources</LayoutSectionTitle>
        <LayoutSectionDescription>
          Inspect what OpenWork controls at runtime versus what belongs to your workspace config. This works through the OpenWork server and does not require the OpenCode engine to be healthy.
        </LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Move OpenWork-managed config</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            Moves older OpenWork-owned runtime keys from `.opencode/openwork.json` and safe OpenWork-managed keys from `opencode.jsonc` into the runtime database.
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void props.onRefresh()}
              disabled={props.busy || props.configStatusBusy || !props.canMigrate}
            >
              <RefreshCcw size={14} className={props.configStatusBusy ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void props.onMigrate()}
              disabled={props.busy || props.migrationBusy || !props.canMigrate}
            >
              <Database size={14} />
              {props.migrationBusy ? "Migrating..." : "Migrate"}
            </Button>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        {props.migrationStatus ? <SettingsNotice>{props.migrationStatus}</SettingsNotice> : null}
        {props.configStatusError ? <SettingsNotice>{props.configStatusError}</SettingsNotice> : null}
        {props.configStatus ? (
          <div className="space-y-3 rounded-xl border border-gray-6 bg-gray-1/60 p-3 text-xs text-gray-10">
            <div className="space-y-2 rounded-xl border border-blue-6/50 bg-blue-2/40 p-3">
              <div className="font-medium text-gray-12">Desired OpenWork runtime config</div>
              <div className="text-[11px] text-gray-9">
                This is the OpenWork-built config object requested for the runtime database and injected safely by the server. Sensitive headers are redacted here.
              </div>
              <RuntimeConfigSummary config={effectiveRuntimeConfig ?? {}} />
              <details className="rounded-lg bg-gray-3 p-2">
                <summary className="cursor-pointer text-[11px] font-medium text-gray-11">Show desired JSON</summary>
                <pre className="mt-2 max-h-72 overflow-auto font-mono text-[11px] text-gray-11">
                  {JSON.stringify(effectiveRuntimeConfig, null, 2)}
                </pre>
              </details>
            </div>
            {props.configStatus.sources ? (
              <div className="space-y-3">
                <div>
                  <div className="font-medium text-gray-12">OpenCode source breakdown</div>
                  <div className="text-[11px] text-gray-9">
                    OpenCode also reads its own project and global config files. OpenWork injects the runtime config separately; for OpenWork-managed keys, the injected config is the source to inspect.
                  </div>
                </div>
                <RuntimeConfigSourceBlock
                  title="Project opencode config"
                  description="Workspace-level OpenCode config owned by the user/project."
                  path={props.configStatus.sources.projectOpencode.path}
                  exists={props.configStatus.sources.projectOpencode.exists}
                  keys={props.configStatus.sources.projectOpencode.keys}
                  config={props.configStatus.sources.projectOpencode.config}
                />
                <RuntimeConfigSourceBlock
                  title="Global opencode config"
                  description="User-level OpenCode config under ~/.config/opencode."
                  path={props.configStatus.sources.globalOpencode.path}
                  exists={props.configStatus.sources.globalOpencode.exists}
                  keys={props.configStatus.sources.globalOpencode.keys}
                  config={props.configStatus.sources.globalOpencode.config}
                />
                <RuntimeConfigSourceBlock
                  title="OpenWork runtime DB"
                  description="OpenWork-managed runtime values stored outside workspace files."
                  keys={props.configStatus.sources.runtimeDatabase.keys}
                  config={props.configStatus.sources.runtimeDatabase.config}
                />
                <RuntimeConfigSourceBlock
                  title="OpenWork injected config"
                  description="The object OpenWork injects into OpenCode at runtime."
                  keys={props.configStatus.sources.injected.keys}
                  config={props.configStatus.sources.injected.config}
                />
              </div>
            ) : null}
            <div>
              <div className="font-medium text-gray-12">Runtime database</div>
              <div>Stored keys: {formatKeys(props.configStatus.runtimeKeys)}</div>
            </div>
            <div>
              <div className="font-medium text-gray-12">Legacy OpenWork metadata</div>
              <div className="break-all">{props.configStatus.legacyOpenwork.path}</div>
              {props.configStatus.legacyOpenwork.error ? (
                <div className="text-amber-11">{props.configStatus.legacyOpenwork.error}; fix this file before moving legacy config.</div>
              ) : null}
              <div>Migratable keys: {formatKeys(props.configStatus.legacyOpenwork.keys)}</div>
            </div>
            <div>
              <div className="font-medium text-gray-12">User opencode.jsonc</div>
              <div className="break-all">{props.configStatus.userOpencode.path}</div>
              <div>{props.configStatus.userOpencode.exists ? "Found" : "Not found"}</div>
              <div>User-owned keys: {formatKeys(props.configStatus.userOpencode.keys)}</div>
              <div>Migratable keys: {formatKeys(props.configStatus.userOpencode.migratableKeys)}</div>
            </div>
            <div>
              <div className="font-medium text-gray-12">Runtime DB JSON</div>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-gray-3 p-2 font-mono text-[11px] text-gray-11">
                {JSON.stringify(runtimeConfig, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}

interface AdvancedOpencodeSectionProps {
  busy: boolean;
  enabled: boolean;
  onToggle: () => void;
}

export function AdvancedOpencodeSection(props: AdvancedOpencodeSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>
          {t("settings.opencode_section_label")}
        </LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.opencode_engine_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.enable_exa")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.enable_exa_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              aria-label={t("settings.enable_exa")}
              checked={props.enabled}
              disabled
              onCheckedChange={props.onToggle}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        <Alert>
          <Info />
          <AlertDescription>{t("settings.exa_unavailable")}</AlertDescription>
        </Alert>
        <LayoutSectionItemFootnote>{t("settings.exa_restart_hint")}</LayoutSectionItemFootnote>
      </LayoutSectionItem>
    </LayoutSection>
  );
}

interface AdvancedFeatureFlagsSectionProps {
  busy: boolean;
  microsandboxCreateSandboxEnabled: boolean;
  onToggleMicrosandboxCreateSandbox: () => void;
}

export function AdvancedFeatureFlagsSection(props: AdvancedFeatureFlagsSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>Feature flags</LayoutSectionTitle>
        <LayoutSectionDescription>Experimental controls for sandbox and workspace behaviors.</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Create Sandbox uses microsandbox image</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            When enabled, Create Sandbox launches the detached worker with the microsandbox image flow instead of the default Docker image flow.
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              aria-label="Create Sandbox uses microsandbox image"
              checked={props.microsandboxCreateSandboxEnabled}
              disabled={props.busy || !isDesktopRuntime()}
              onCheckedChange={props.onToggleMicrosandboxCreateSandbox}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </LayoutSection>
  );
}

interface AdvancedDeveloperSectionProps {
  busy: boolean;
  developerMode: boolean;
  opencodeDevModeEnabled: boolean;
  deepLinkOpen: boolean;
  deepLinkInput: string;
  deepLinkBusy: boolean;
  deepLinkStatus: string | null;
  onToggleDeveloperMode: () => void;
  onToggleDeepLink: () => void;
  onDeepLinkInput: (input: string) => void;
  onSubmitDeepLink: () => Promise<void>;
}

export function AdvancedDeveloperSection(props: AdvancedDeveloperSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.developer")}</LayoutSectionTitle>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.developer_mode_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.developer_mode_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              aria-label={t("settings.developer_mode_title")}
              checked={props.developerMode}
              onCheckedChange={props.onToggleDeveloperMode}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>

      {isDesktopRuntime() && props.opencodeDevModeEnabled && props.developerMode ? (
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.open_deeplink_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.open_deeplink_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={props.onToggleDeepLink}
                disabled={props.busy || props.deepLinkBusy}
              >
                {props.deepLinkOpen ? t("common.hide") : t("settings.open_deeplink_button")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>

          {props.deepLinkOpen ? (
            <div className="space-y-3">
              <Field>
                <FieldLabel htmlFor="advanced-debug-deep-link">{t("settings.open_deeplink_title")}</FieldLabel>
                <Textarea
                  id="advanced-debug-deep-link"
                  value={props.deepLinkInput}
                  onChange={(event) => props.onDeepLinkInput(event.currentTarget.value)}
                  rows={3}
                  placeholder="openwork://..."
                  className="font-mono text-xs"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void props.onSubmitDeepLink()}
                  disabled={props.busy || props.deepLinkBusy || !props.deepLinkInput.trim()}
                >
                  {props.deepLinkBusy ? t("settings.opening") : t("settings.open_deeplink_action")}
                </Button>
                <div className="text-xs text-gray-8">{t("settings.deeplink_hint")}</div>
              </div>
            </div>
          ) : null}

          {props.deepLinkStatus ? <SettingsNotice>{props.deepLinkStatus}</SettingsNotice> : null}
        </LayoutSectionItem>
      ) : null}
    </LayoutSection>
  );
}

interface AdvancedConnectionSectionProps {
  busy: boolean;
  headerStatus: string;
  baseUrl: string;
  openworkServerUrl: string;
  openworkServerStatus: OpenworkServerStatus;
  openworkReconnectBusy: boolean;
  isLocalEngineRunning: boolean;
  restartBusy: boolean;
  reconnectStatus: string | null;
  reconnectError: string | null;
  restartStatus: string | null;
  restartError: string | null;
  onReconnect: () => Promise<void>;
  onRestart: () => Promise<void>;
  onStopHost: () => void;
}

export function AdvancedConnectionSection(props: AdvancedConnectionSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.connection_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{props.headerStatus}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem className="gap-3">
        <div className="break-all font-mono text-xs text-gray-8">{props.baseUrl}</div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void props.onReconnect()}
            disabled={props.busy || props.openworkReconnectBusy || !props.openworkServerUrl.trim()}
          >
            <RefreshCcw size={14} className={props.openworkReconnectBusy ? "animate-spin" : ""} />
            {props.openworkReconnectBusy ? t("settings.reconnecting") : t("settings.reconnect_server")}
          </Button>

          {props.isLocalEngineRunning ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void props.onRestart()}
              disabled={props.busy || props.restartBusy}
            >
              <RefreshCcw size={14} className={props.restartBusy ? "animate-spin" : ""} />
              {props.restartBusy ? t("settings.restarting") : t("settings.restart_openwork_server")}
            </Button>
          ) : null}

          {props.isLocalEngineRunning ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={props.onStopHost}
              disabled={props.busy}
            >
              <CircleAlert size={14} />
              {t("settings.stop_local_server")}
            </Button>
          ) : null}

          {!props.isLocalEngineRunning && props.openworkServerStatus === "connected" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onStopHost}
              disabled={props.busy}
            >
              {t("settings.disconnect_server")}
            </Button>
          ) : null}
        </div>

        {props.reconnectStatus ? <SettingsNotice>{props.reconnectStatus}</SettingsNotice> : null}
        {props.reconnectError ? <SettingsNotice tone="error">{props.reconnectError}</SettingsNotice> : null}
        {props.restartStatus ? <SettingsNotice>{props.restartStatus}</SettingsNotice> : null}
        {props.restartError ? <SettingsNotice tone="error">{props.restartError}</SettingsNotice> : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}
