/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { CircleAlert, Cpu, Info, RefreshCcw, Server } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { OpenworkServerStatus } from "@/app/lib/openwork-server";
import type { EngineInfo } from "@/app/lib/desktop-types";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";
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

function formatOpencodeBinary(info: EngineInfo | null) {
  const binary = info?.opencodeBinPath?.trim();
  if (!binary) return "—";
  const source = info?.opencodeBinSource?.trim();
  return source ? `${binary} (${source})` : binary;
}

interface AdvancedRuntimeSectionProps {
  engineInfo: EngineInfo | null;
  clientStatusLabel: string;
  clientTone: SettingsTone;
  openworkStatusLabel: string;
  openworkTone: SettingsTone;
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
          detailLines={[
            t("settings.diag_opencode_binary", undefined, {
              binary: formatOpencodeBinary(props.engineInfo),
            }),
          ]}
        />
        <RuntimeStatusCard
          icon={<Server size={18} />}
          title={t("settings.openwork_server_label")}
          description={t("settings.openwork_server_desc")}
          statusLabel={props.openworkStatusLabel}
          tone={props.openworkTone}
        />
      </div>
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
