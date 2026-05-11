/** @jsxImportSource react */
import { AlertTriangle, Cloud, Lock, RotateCcw } from "lucide-react";
import { Separator } from "@/components/ui/separator";

import { Button } from "../../../design-system/button";
import {
  SettingsStack,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderTitle,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderActions,
  SettingsInset,
  SettingsNotice,
} from "../settings-section";
import { useShellConfig, DEFAULT_SHELL_CONFIG, type ShellConfig } from "../../../shell/shell-config";

/* ------------------------------------------------------------------ */
/*  Toggle row                                                         */
/* ------------------------------------------------------------------ */

type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  warning?: string | null;
  cloudOnly?: boolean;
};

function ToggleRow(props: ToggleRowProps) {
  return (
    <SettingsInset className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-dls-text">{props.label}</span>
          {props.cloudOnly ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-dls-hover px-1.5 py-0.5 text-[10px] font-medium text-dls-secondary">
              <Lock size={9} />
              Cloud only
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[12px] text-dls-secondary">{props.description}</div>
        {props.warning && !props.checked ? (
          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-11">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{props.warning}</span>
          </div>
        ) : null}
      </div>
      <Button
        variant="outline"
        className="h-8 shrink-0 px-3 py-0 text-xs"
        onClick={() => props.onChange(!props.checked)}
        disabled={props.disabled || props.cloudOnly}
      >
        {props.checked ? "On" : "Off"}
      </Button>
    </SettingsInset>
  );
}

/* ------------------------------------------------------------------ */
/*  Text input row                                                     */
/* ------------------------------------------------------------------ */

type TextRowProps = {
  label: string;
  description: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
};

function TextRow(props: TextRowProps) {
  return (
    <SettingsInset className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-dls-text">{props.label}</div>
        <div className="mt-0.5 text-[12px] text-dls-secondary">{props.description}</div>
      </div>
      <input
        className="h-8 w-40 shrink-0 rounded-lg border border-dls-border bg-dls-surface px-3 text-xs text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
    </SettingsInset>
  );
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function ShellCustomizationView() {
  const { config, update, reset } = useShellConfig();

  const isDefault = (Object.keys(DEFAULT_SHELL_CONFIG) as (keyof ShellConfig)[]).every(
    (key) => config[key] === DEFAULT_SHELL_CONFIG[key],
  );

  return (
    <SettingsStack>
      {/* ---- Branding ---- */}
      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              Branding
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              Customize the app name shown in the title bar, sidebar, and welcome page.
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>

        <TextRow
          label="App name"
          description="Shown in the title bar, sidebar header, and welcome screen."
          value={config.appName}
          placeholder="OpenWork"
          onChange={(value) => update({ appName: value || DEFAULT_SHELL_CONFIG.appName })}
        />
      </SettingsSection>

      <Separator />

      {/* ---- Visibility ---- */}
      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              Shell visibility
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              Control which parts of the app shell are visible. Hidden elements can still be accessed via the command palette (Cmd+K).
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>

        <ToggleRow
          label="Status bar"
          description="The bottom bar showing connection status, docs, and feedback."
          checked={config.statusBar}
          onChange={(v) => update({ statusBar: v })}
          warning="When hidden, the only way to access settings is via Cmd+K."
        />

        <ToggleRow
          label="Sidebar"
          description="The left panel with workspace and session list."
          checked={config.sidebar}
          onChange={(v) => update({ sidebar: v })}
        />

        <ToggleRow
          label="Docs button"
          description="Link to documentation in the status bar."
          checked={config.docsButton}
          onChange={(v) => update({ docsButton: v })}
        />

        <ToggleRow
          label="Feedback button"
          description="Feedback link in the status bar."
          checked={config.feedbackButton}
          onChange={(v) => update({ feedbackButton: v })}
        />

        <ToggleRow
          label="Cloud sign-in"
          description="Sign-in button shown when not connected to OpenWork Cloud."
          checked={config.cloudSignin}
          onChange={(v) => update({ cloudSignin: v })}
        />

        <ToggleRow
          label="Welcome page"
          description="Onboarding screen shown to new users."
          checked={config.welcomePage}
          onChange={(v) => update({ welcomePage: v })}
        />

        <ToggleRow
          label="Starter cards"
          description="Suggested task cards in empty sessions."
          checked={config.starterCards}
          onChange={(v) => update({ starterCards: v })}
        />
      </SettingsSection>

      <Separator />

      {/* ---- Cloud-managed (grayed out) ---- */}
      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              <Cloud size={16} />
              Cloud-managed
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              These settings are managed by your organization via OpenWork Cloud. Contact your admin to change them.
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>

        <ToggleRow
          label="Settings access"
          description="Whether the settings panel is accessible from the UI."
          checked={true}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label="Model restrictions"
          description="Restrict which models and providers are available."
          checked={false}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label="Extension restrictions"
          description="Control which MCPs, plugins, and skills can be installed."
          checked={false}
          onChange={() => {}}
          cloudOnly
        />
      </SettingsSection>

      <Separator />

      {/* ---- Reset ---- */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-dls-secondary">
          {isDefault ? "All settings are at their defaults." : "Some settings have been customized."}
        </div>
        <Button
          variant="outline"
          className="h-8 px-3 text-xs"
          onClick={reset}
          disabled={isDefault}
        >
          <RotateCcw size={12} />
          Reset to defaults
        </Button>
      </div>
    </SettingsStack>
  );
}
