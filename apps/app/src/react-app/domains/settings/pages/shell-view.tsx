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
/*  Interactive wireframe preview                                      */
/* ------------------------------------------------------------------ */

function ShellWireframe({ config }: { config: ShellConfig }) {
  const on = "fill-dls-text opacity-100 transition-all duration-300";
  const off = "fill-dls-secondary opacity-15 transition-all duration-300";
  const onStroke = "stroke-dls-text opacity-60 transition-all duration-300";
  const offStroke = "stroke-dls-secondary opacity-10 transition-all duration-300";

  return (
    <div className="mx-auto mb-2 w-full max-w-md">
      <svg viewBox="0 0 400 240" className="w-full" aria-hidden="true">
        {/* Window frame */}
        <rect x="0" y="0" width="400" height="240" rx="12" fill="none" stroke="var(--dls-border)" strokeWidth="1.5" />

        {/* Title bar: two rects to avoid rounded-bottom-corner gap */}
        <rect x="1" y="1" width="398" height="28" rx="11" className="fill-dls-hover" />
        <rect x="1" y="16" width="398" height="13" className="fill-dls-hover" />
        {/* Traffic lights */}
        <circle cx="16" cy="15" r="4" className="fill-red-9 opacity-40" />
        <circle cx="28" cy="15" r="4" className="fill-amber-9 opacity-40" />
        <circle cx="40" cy="15" r="4" className="fill-green-9 opacity-40" />
        {/* App name */}
        <text x="200" y="19" textAnchor="middle" className="fill-dls-secondary text-[9px] font-medium">
          {config.appName}
        </text>

        {/* Sidebar */}
        <rect
          x="1" y="29" width="100" height="180"
          className={config.sidebar ? on : off}
          style={{ fill: config.sidebar ? "var(--dls-hover)" : "var(--dls-surface)" }}
        />
        <line x1="101" y1="29" x2="101" y2="209" className={config.sidebar ? onStroke : offStroke} strokeWidth="1" />
        {/* Sidebar items */}
        {config.sidebar ? (
          <>
            <rect x="12" y="40" width="60" height="6" rx="3" className="fill-dls-secondary opacity-30" />
            <rect x="12" y="54" width="76" height="6" rx="3" className="fill-dls-secondary opacity-20" />
            <rect x="12" y="68" width="50" height="6" rx="3" className="fill-dls-secondary opacity-20" />
            <rect x="12" y="82" width="68" height="6" rx="3" className="fill-dls-secondary opacity-15" />
            <rect x="12" y="96" width="55" height="6" rx="3" className="fill-dls-secondary opacity-15" />
            {config.addWorkspace ? (
              <rect x="12" y="175" width="76" height="14" rx="7" className="fill-dls-accent opacity-20" />
            ) : null}
          </>
        ) : null}

        {/* Main content area */}
        <rect
          x={config.sidebar ? "102" : "1"} y="29"
          width={config.sidebar ? "297" : "398"} height="180"
          className="fill-dls-surface"
        />
        {/* Chat bubbles */}
        <rect x={config.sidebar ? "260" : "200"} y="50" width="110" height="20" rx="10" className="fill-dls-hover" />
        <rect x={config.sidebar ? "120" : "20"} y="85" width="160" height="14" rx="3" className="fill-dls-secondary opacity-15" />
        <rect x={config.sidebar ? "120" : "20"} y="105" width="120" height="14" rx="3" className="fill-dls-secondary opacity-10" />

        {/* Starter cards */}
        {config.starterCards ? (
          <g>
            <rect x={config.sidebar ? "120" : "20"} y="140" width="80" height="30" rx="6" className="fill-dls-hover opacity-50" />
            <rect x={config.sidebar ? "210" : "110"} y="140" width="80" height="30" rx="6" className="fill-dls-hover opacity-50" />
            <rect x={config.sidebar ? "300" : "200"} y="140" width="80" height="30" rx="6" className="fill-dls-hover opacity-50" />
          </g>
        ) : null}

        {/* Composer */}
        <rect
          x={config.sidebar ? "112" : "12"} y="185"
          width={config.sidebar ? "276" : "376"} height="18"
          rx="9" fill="none" stroke="var(--dls-border)" strokeWidth="1"
        />

        {/* Status bar */}
        <rect
          x="1" y="209" width="398" height="30" rx="0"
          className={config.statusBar ? "transition-all duration-300" : off}
          style={{ fill: config.statusBar ? "var(--dls-hover)" : "var(--dls-surface)" }}
        />
        <rect x="1" y="228" width="398" height="12" rx="0" className="fill-dls-surface" style={{ clipPath: "inset(0 0 0 0 round 0 0 11px 11px)" }} />

        {config.statusBar ? (
          <>
            {/* Status dot */}
            <circle cx="14" cy="222" r="3" className="fill-green-9 opacity-50" />
            <rect x="22" y="219" width="40" height="6" rx="3" className="fill-dls-secondary opacity-25" />
            {/* Right side buttons */}
            {config.cloudSignin ? (
              <rect x="290" y="216" width="36" height="12" rx="6" className="fill-dls-accent opacity-25" />
            ) : null}
            {config.docsButton ? (
              <rect x="332" y="219" width="20" height="6" rx="3" className="fill-dls-secondary opacity-20" />
            ) : null}
            {config.feedbackButton ? (
              <rect x="358" y="219" width="24" height="6" rx="3" className="fill-dls-secondary opacity-20" />
            ) : null}
          </>
        ) : null}

        {/* Browser panel indicator */}
        {config.browser ? (
          <line
            x1="399" y1="29" x2="399" y2="209"
            stroke="var(--dls-accent)" strokeWidth="2" opacity="0.2"
          />
        ) : null}
      </svg>
    </div>
  );
}

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

        <SettingsInset className="p-4">
          <ShellWireframe config={config} />
        </SettingsInset>

        <ToggleRow
          label="Sidebar"
          description="The left panel with workspace and session list."
          checked={config.sidebar}
          onChange={(v) => update({ sidebar: v })}
        />

        <ToggleRow
          label="Status bar"
          description="The bottom bar showing connection status and quick actions."
          checked={config.statusBar}
          onChange={(v) => update({ statusBar: v })}
          warning="When hidden, the only way to access settings is via Cmd+K."
        />

        {config.statusBar ? (
          <SettingsInset className="ml-6 space-y-0 divide-y divide-dls-border p-0">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <span className="text-[13px] font-medium text-dls-text">Docs button</span>
                <div className="text-[11px] text-dls-secondary">Link to documentation.</div>
              </div>
              <Button variant="outline" className="h-7 shrink-0 px-2.5 py-0 text-[11px]" onClick={() => update({ docsButton: !config.docsButton })}>
                {config.docsButton ? "On" : "Off"}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <span className="text-[13px] font-medium text-dls-text">Feedback button</span>
                <div className="text-[11px] text-dls-secondary">Send feedback link.</div>
              </div>
              <Button variant="outline" className="h-7 shrink-0 px-2.5 py-0 text-[11px]" onClick={() => update({ feedbackButton: !config.feedbackButton })}>
                {config.feedbackButton ? "On" : "Off"}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <span className="text-[13px] font-medium text-dls-text">Cloud sign-in</span>
                <div className="text-[11px] text-dls-secondary">Sign-in button when not connected.</div>
              </div>
              <Button variant="outline" className="h-7 shrink-0 px-2.5 py-0 text-[11px]" onClick={() => update({ cloudSignin: !config.cloudSignin })}>
                {config.cloudSignin ? "On" : "Off"}
              </Button>
            </div>
          </SettingsInset>
        ) : null}

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

        <ToggleRow
          label="Model picker"
          description="Allow users to change the default model."
          checked={config.modelPicker}
          onChange={(v) => update({ modelPicker: v })}
        />

        <ToggleRow
          label="Browser panel"
          description="Show the built-in browser panel toggle."
          checked={config.browser}
          onChange={(v) => update({ browser: v })}
        />

        <ToggleRow
          label="Add workspace"
          description="Allow creating or connecting new workspaces."
          checked={config.addWorkspace}
          onChange={(v) => update({ addWorkspace: v })}
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
