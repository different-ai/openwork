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
  const cx = config.sidebar ? 102 : 1;
  const cw = config.sidebar ? 297 : 398;

  return (
    <div className="mx-auto mb-2 w-full max-w-md">
      <svg viewBox="0 0 400 260" className="w-full" aria-hidden="true">
        {/* Window frame */}
        <rect x="0" y="0" width="400" height="260" rx="10" fill="var(--dls-surface)" stroke="var(--dls-border)" strokeWidth="1" />

        {/* Title bar */}
        <rect x="0.5" y="0.5" width="399" height="30" rx="10" fill="var(--dls-hover)" />
        <rect x="0.5" y="18" width="399" height="13" fill="var(--dls-hover)" />
        <line x1="0" y1="30" x2="400" y2="30" stroke="var(--dls-border)" strokeWidth="0.5" />
        <circle cx="14" cy="15" r="3.5" fill="#ff5f57" opacity="0.6" />
        <circle cx="26" cy="15" r="3.5" fill="#febc2e" opacity="0.6" />
        <circle cx="38" cy="15" r="3.5" fill="#28c840" opacity="0.6" />
        <text x="200" y="19" textAnchor="middle" fontSize="8" fontWeight="600" fill="var(--dls-text-secondary)" opacity="0.7">
          {config.appName}
        </text>

        {/* Sidebar */}
        <g className="transition-all duration-300" style={{ opacity: config.sidebar ? 1 : 0.1 }}>
          <rect x="0.5" y="31" width="100" height="195" fill="var(--dls-hover)" />
          <line x1="101" y1="31" x2="101" y2="226" stroke="var(--dls-border)" strokeWidth="0.5" />

          {/* Workspace header */}
          <circle cx="16" cy="44" r="5" fill="var(--dls-accent)" opacity="0.3" />
          <text x="26" y="47" fontSize="6.5" fontWeight="600" fill="var(--dls-text-primary)" opacity="0.7">Workspace</text>

          {/* Session list */}
          <rect x="8" y="58" width="85" height="16" rx="4" fill="var(--dls-surface)" opacity="0.6" />
          <text x="14" y="68" fontSize="5.5" fill="var(--dls-text-primary)" opacity="0.5">Meeting brief</text>

          <rect x="8" y="78" width="85" height="16" rx="4" fill="transparent" />
          <text x="14" y="88" fontSize="5.5" fill="var(--dls-text-secondary)" opacity="0.4">Contract review</text>

          <rect x="8" y="98" width="85" height="16" rx="4" fill="transparent" />
          <text x="14" y="108" fontSize="5.5" fill="var(--dls-text-secondary)" opacity="0.4">Outreach CRM</text>

          {/* New session button */}
          <text x="14" y="130" fontSize="5" fill="var(--dls-text-secondary)" opacity="0.3">+ New session</text>

          {/* Add workspace */}
          {config.addWorkspace ? (
            <g>
              <rect x="8" y="200" width="85" height="16" rx="8" fill="var(--dls-accent)" opacity="0.15" />
              <text x="50" y="210" textAnchor="middle" fontSize="5.5" fontWeight="500" fill="var(--dls-accent)" opacity="0.6">Add workspace</text>
            </g>
          ) : null}
        </g>

        {/* Main content */}
        <rect x={cx} y="31" width={cw} height="195" fill="var(--dls-surface)" />

        {/* Starter cards */}
        <g className="transition-all duration-300" style={{ opacity: config.starterCards ? 1 : 0 }}>
          {[
            { x: cx + 12, icon: "\u{1F4CA}", label: "Edit a CSV" },
            { x: cx + 12 + (cw - 36) / 3 + 6, icon: "\u{1F310}", label: "Browse web" },
            { x: cx + 12 + ((cw - 36) / 3 + 6) * 2, icon: "\u{1F50C}", label: "Extensions" },
          ].map((card, i) => {
            const w = (cw - 36) / 3;
            return (
              <g key={i}>
                <rect x={card.x} y="120" width={w} height="34" rx="5" fill="none" stroke="var(--dls-border)" strokeWidth="0.5" />
                <text x={card.x + 6} y="133" fontSize="7">{card.icon}</text>
                <text x={card.x + 16} y="133" fontSize="5" fontWeight="500" fill="var(--dls-text-primary)" opacity="0.5">{card.label}</text>
                <rect x={card.x + 6} y="140" width={w - 16} height="3" rx="1.5" fill="var(--dls-text-secondary)" opacity="0.06" />
              </g>
            );
          })}
        </g>

        {/* Composer */}
        <rect x={cx + 10} y="196" width={cw - 20} height="22" rx="11" fill="none" stroke="var(--dls-border)" strokeWidth="0.75" />
        <text x={cx + 24} y="210" fontSize="5.5" fill="var(--dls-text-secondary)" opacity="0.3">Describe your task...</text>
        {/* Send button */}
        <rect x={cx + cw - 42} y="200" width="24" height="14" rx="7" fill="var(--dls-accent)" opacity="0.2" />
        <text x={cx + cw - 30} y="210" textAnchor="middle" fontSize="4.5" fontWeight="500" fill="var(--dls-accent)" opacity="0.5">Run</text>

        {/* Model picker */}
        {config.modelPicker ? (
          <text x={cx + 14} y="174" fontSize="4.5" fill="var(--dls-text-secondary)" opacity="0.3">big-pickle</text>
        ) : null}

        {/* Status bar */}
        <g className="transition-all duration-300" style={{ opacity: config.statusBar ? 1 : 0.08 }}>
          <line x1="0" y1="226" x2="400" y2="226" stroke="var(--dls-border)" strokeWidth="0.5" />
          <rect x="0.5" y="226" width="399" height="33.5" rx="0" fill="var(--dls-hover)" />
          {/* Bottom corners */}
          <rect x="0.5" y="250" width="399" height="10" rx="10" fill="var(--dls-hover)" />

          {/* Status dot + label */}
          <circle cx="14" cy="242" r="2.5" fill="#28c840" opacity="0.5" />
          <text x="22" y="245" fontSize="5.5" fontWeight="500" fill="var(--dls-text-primary)" opacity="0.5">Ready</text>

          {/* Cloud sign-in */}
          {config.cloudSignin ? (
            <g>
              <rect x="280" y="236" width="32" height="12" rx="6" fill="var(--dls-accent)" opacity="0.2" />
              <text x="296" y="244" textAnchor="middle" fontSize="4.5" fontWeight="500" fill="var(--dls-accent)" opacity="0.5">Sign in</text>
            </g>
          ) : null}

          {/* Docs */}
          {config.docsButton ? (
            <text x="326" y="244" fontSize="5" fill="var(--dls-text-secondary)" opacity="0.35">Docs</text>
          ) : null}

          {/* Feedback */}
          {config.feedbackButton ? (
            <text x="350" y="244" fontSize="5" fill="var(--dls-text-secondary)" opacity="0.35">Feedback</text>
          ) : null}

          {/* Settings gear */}
          <text x="388" y="245" textAnchor="middle" fontSize="7" fill="var(--dls-text-secondary)" opacity="0.3">{"\u2699"}</text>
        </g>

        {/* Browser panel */}
        <g className="transition-all duration-300" style={{ opacity: config.browser ? 1 : 0 }}>
          <line x1={cx + cw - 120} y1="31" x2={cx + cw - 120} y2="226" stroke="var(--dls-border)" strokeWidth="0.5" />
          <rect x={cx + cw - 120} y="31" width="120" height="195" fill="var(--dls-hover)" opacity="0.5" />
          {/* Browser chrome */}
          <rect x={cx + cw - 115} y="36" width="110" height="14" rx="4" fill="var(--dls-surface)" />
          <circle cx={cx + cw - 108} cy="43" r="2" fill="var(--dls-text-secondary)" opacity="0.2" />
          <circle cx={cx + cw - 100} cy="43" r="2" fill="var(--dls-text-secondary)" opacity="0.2" />
          <rect x={cx + cw - 92} y="40" width="60" height="6" rx="3" fill="var(--dls-text-secondary)" opacity="0.08" />
          {/* Page content placeholder */}
          <rect x={cx + cw - 112} y="56" width="100" height="6" rx="2" fill="var(--dls-text-secondary)" opacity="0.07" />
          <rect x={cx + cw - 112} y="66" width="80" height="6" rx="2" fill="var(--dls-text-secondary)" opacity="0.05" />
          <rect x={cx + cw - 112} y="76" width="90" height="6" rx="2" fill="var(--dls-text-secondary)" opacity="0.05" />
          <rect x={cx + cw - 112} y="92" width="100" height="50" rx="4" fill="var(--dls-surface)" opacity="0.6" />
        </g>
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
