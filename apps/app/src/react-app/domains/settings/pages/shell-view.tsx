/** @jsxImportSource react */
import { AlertTriangle, Info, Lock, RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { useShellConfig, DEFAULT_SHELL_CONFIG, type ShellConfig } from "../../../shell/shell-config";
import { useUiStateStore } from "../../../shell/ui-state-store";

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
          {/* Browser frame */}
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
  unavailable?: string | null;
  warning?: string | null;
  cloudOnly?: boolean;
  className?: string;
};

function CloudOnlyBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-dls-hover size-5 justify-center text-xs font-medium text-dls-secondary" aria-label="Cloud only">
      <Lock className="size-3" />
    </span>
  );
}

function ToggleRow(props: ToggleRowProps) {
  return (
    <LayoutSectionItem className={cn("gap-3", props.className)}>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>
          {props.label}
          {props.cloudOnly ? <CloudOnlyBadge /> : null}
        </LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{props.description}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Switch
            aria-label={props.label}
            checked={props.checked}
            disabled={props.disabled || props.cloudOnly}
            onCheckedChange={props.onChange}
          />
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      {props.warning && !props.checked ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>{props.warning}</AlertDescription>
        </Alert>
      ) : null}
      {props.unavailable ? (
        <Alert>
          <Info />
          <AlertDescription>{props.unavailable}</AlertDescription>
        </Alert>
      ) : null}
    </LayoutSectionItem>
  );
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function ShellCustomizationView() {
  const { config, update, reset } = useShellConfig();
  const applicationMenuVisible = useUiStateStore((state) => state.applicationMenuVisible);
  const setApplicationMenuVisible = useUiStateStore((state) => state.setApplicationMenuVisible);

  const isDefault = (Object.keys(DEFAULT_SHELL_CONFIG) as (keyof ShellConfig)[]).every(
    (key) => config[key] === DEFAULT_SHELL_CONFIG[key],
  ) && !applicationMenuVisible;

  const resetAll = () => {
    reset();
    setApplicationMenuVisible(false);
  };

  return (
    <LayoutStack>
      {/* ---- Branding ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Branding</LayoutSectionTitle>
          <LayoutSectionDescription>
            Customize the name your users see across the app.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Change application name</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              Appears in the title bar, sidebar, and welcome screen.
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Field className="w-64 max-w-full gap-0">
               <FieldLabel className="sr-only" htmlFor="shell-app-name">
                  App name
                </FieldLabel>
                <Input
                  id="shell-app-name"
                  className="h-8 text-xs"
                  value={config.appName}
                  placeholder="OpenWork"
                  disabled
                  onChange={(event) => update({ appName: event.currentTarget.value || DEFAULT_SHELL_CONFIG.appName })}
                />
              </Field>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <Alert>
            <Info />
            <AlertDescription>Changing the application name is not available yet.</AlertDescription>
          </Alert>
        </LayoutSectionItem>
      </LayoutSection>

      <Separator />

      {/* ---- Visibility ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Layout</LayoutSectionTitle>
          <LayoutSectionDescription>
            Customize what's visible in the interface.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <Alert>
          <AlertDescription>
            Anything you hide is still available via the command palette (Cmd+K).
          </AlertDescription>
        </Alert>

        <LayoutSectionItem className="rounded-2xl border border-dls-border p-4">
          <ShellWireframe config={config} />
        </LayoutSectionItem>

        <ToggleRow
          label="Display sidebar"
          description="Browse workspaces and past sessions from a side panel."
          checked={config.sidebar}
          onChange={(v) => update({ sidebar: v })}
        />

        <ToggleRow
          label="Display status bar"
          description="Quick access to status, settings, and actions along the bottom edge."
          checked={config.statusBar}
          onChange={(v) => update({ statusBar: v })}
          warning="When hidden, the only way to access settings is via Cmd+K."
        />

        {config.statusBar ? (
          <div className="ml-6 flex flex-col gap-3 border border-dls-border px-4 py-4 rounded-2xl -mr-4">
            <ToggleRow
              label="Display documentation link"
              description="Show a link to your documentation."
              checked={config.docsButton}
              onChange={(value) => update({ docsButton: value })}
            />
            <ToggleRow
              label="Display feedback button"
              description="Show a button for submitting feedback."
              checked={config.feedbackButton}
              onChange={(value) => update({ feedbackButton: value })}
            />
            <ToggleRow
              label="Display cloud sign-in"
              description="Show a sign-in prompt for users who aren't logged in."
              checked={config.cloudSignin}
              onChange={(value) => update({ cloudSignin: value })}
            />
          </div>
        ) : null}

        <ToggleRow
          label="Display notifications"
          description="A bell in the header collecting updates from OpenWork Cloud and your workspaces."
          checked={config.notifications}
          onChange={(v) => update({ notifications: v })}
        />

        <ToggleRow
          label="Display task suggestions"
          description="Show task suggestions to help users get started."
          checked={config.starterCards}
          onChange={(v) => update({ starterCards: v })}
        />

        <ToggleRow
          label="Display model picker"
          description="Let users choose which AI model to use."
          checked={config.modelPicker}
          onChange={(v) => update({ modelPicker: v })}
          disabled
          unavailable="The model picker display control is not available yet."
        />

        <ToggleRow
          label="Display browser panel"
          description="A built-in browser for viewing web content alongside sessions."
          checked={config.browser}
          onChange={(v) => update({ browser: v })}
          disabled
          unavailable="The browser panel display control is not available yet."
        />

        <ToggleRow
          label="Display menu bar"
          description="Show the native desktop menu bar."
          checked={applicationMenuVisible}
          onChange={setApplicationMenuVisible}
          className="hidden windows:flex linux:flex"
        />

        <ToggleRow
          label="Display new workspace button"
          description="Let users create or join additional workspaces."
          checked={config.addWorkspace}
          onChange={(v) => update({ addWorkspace: v })}
          disabled
          unavailable="The new workspace button display control is not available yet."
        />
      </LayoutSection>

      <Separator />

      {/* ---- Cloud-managed (grayed out) ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Organization-wide settings</LayoutSectionTitle>
          <LayoutSectionDescription>
            These settings are managed by your organization via OpenWork Cloud.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <Alert variant="warning">
          <Lock />
          <AlertDescription>
            These settings can only be changed by your organization admin. Contact your admin to make changes.
          </AlertDescription>
        </Alert>

        <ToggleRow
          label="Settings access"
          description="Let users open the settings panel."
          checked={true}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label="Model restrictions"
          description="Limit which AI models and providers users can choose from."
          checked={false}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label="Extension restrictions"
          description="Limit which extensions, plugins, and skills users can install."
          checked={false}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label="Enable welcome page"
          description="A getting-started screen for first-time users."
          checked={config.welcomePage}
          onChange={(v) => update({ welcomePage: v })}
          cloudOnly
          disabled
        />
      </LayoutSection>

      <Separator />

      {/* ---- Reset ---- */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-dls-secondary">
          {isDefault ? "All settings are at their defaults." : "Some settings have been customized."}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={resetAll}
          disabled={isDefault}
        >
          <RotateCcw size={12} />
          Reset to defaults
        </Button>
      </div>
    </LayoutStack>
  );
}
