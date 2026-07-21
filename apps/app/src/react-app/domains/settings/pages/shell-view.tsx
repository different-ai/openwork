/** @jsxImportSource react */
import { AlertTriangle, Info, Lock, RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

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
import { useBrandAppName } from "../../cloud/brand-theme";

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
  const brandAppName = useBrandAppName();
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
          <LayoutSectionTitle>{t("shell.branding_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>
            {t("shell.branding_desc")}
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("shell.change_app_name")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("shell.change_app_name_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Field className="w-64 max-w-full gap-0">
               <FieldLabel className="sr-only" htmlFor="shell-app-name">
                  App name
                </FieldLabel>
                <Input
                  id="shell-app-name"
                  className="h-8 text-xs"
                  value={brandAppName}
                  placeholder="OpenWork"
                  disabled
                  onChange={(event) => update({ appName: event.currentTarget.value || DEFAULT_SHELL_CONFIG.appName })}
                />
              </Field>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <Alert>
            <Info />
            <AlertDescription>
              {brandAppName === "OpenWork" ? t("shell.no_custom_name") : t("shell.managed_name")}
            </AlertDescription>
          </Alert>
        </LayoutSectionItem>
      </LayoutSection>

      <Separator />

      {/* ---- Visibility ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("shell.layout_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>
            {t("shell.layout_desc")}
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <Alert>
          <AlertDescription>
            {t("shell.cmd_palette_hint")}
          </AlertDescription>
        </Alert>

        <LayoutSectionItem className="rounded-2xl border border-dls-border p-4">
          <ShellWireframe config={{ ...config, appName: brandAppName }} />
        </LayoutSectionItem>

        <ToggleRow
          label={t("shell.display_sidebar")}
          description={t("shell.display_sidebar_desc")}
          checked={config.sidebar}
          onChange={(v) => update({ sidebar: v })}
        />

        <ToggleRow
          label={t("shell.display_status_bar")}
          description={t("shell.display_status_bar_desc")}
          checked={config.statusBar}
          onChange={(v) => update({ statusBar: v })}
          warning={t("shell.status_bar_warning")}
        />

        {config.statusBar ? (
          <div className="ml-6 flex flex-col gap-3 border border-dls-border px-4 py-4 rounded-2xl -mr-4">
            <ToggleRow
              label={t("shell.display_docs")}
              description={t("shell.display_docs_desc")}
              checked={config.docsButton}
              onChange={(value) => update({ docsButton: value })}
            />
            <ToggleRow
              label={t("shell.display_feedback")}
              description={t("shell.display_feedback_desc")}
              checked={config.feedbackButton}
              onChange={(value) => update({ feedbackButton: value })}
            />
            <ToggleRow
              label={t("shell.display_cloud_signin")}
              description={t("shell.display_cloud_signin_desc")}
              checked={config.cloudSignin}
              onChange={(value) => update({ cloudSignin: value })}
            />
          </div>
        ) : null}

        <ToggleRow
          label={t("shell.display_notifications")}
          description={t("shell.display_notifications_desc")}
          checked={config.notifications}
          onChange={(v) => update({ notifications: v })}
        />

        <ToggleRow
          label={t("shell.display_suggestions")}
          description={t("shell.display_suggestions_desc")}
          checked={config.starterCards}
          onChange={(v) => update({ starterCards: v })}
        />

        <ToggleRow
          label={t("shell.display_model_picker")}
          description={t("shell.display_model_picker_desc")}
          checked={config.modelPicker}
          onChange={(v) => update({ modelPicker: v })}
          disabled
          unavailable={t("shell.unavailable_model_picker")}
        />

        <ToggleRow
          label={t("shell.display_browser")}
          description={t("shell.display_browser_desc")}
          checked={config.browser}
          onChange={(v) => update({ browser: v })}
          disabled
          unavailable={t("shell.unavailable_browser")}
        />

        <ToggleRow
          label={t("shell.display_menu_bar")}
          description={t("shell.display_menu_bar_desc")}
          checked={applicationMenuVisible}
          onChange={setApplicationMenuVisible}
          className="hidden windows:flex linux:flex"
        />

        <ToggleRow
          label={t("shell.display_new_workspace")}
          description={t("shell.display_new_workspace_desc")}
          checked={config.addWorkspace}
          onChange={(v) => update({ addWorkspace: v })}
          disabled
          unavailable={t("shell.unavailable_workspace_button")}
        />
      </LayoutSection>

      <Separator />

      {/* ---- Cloud-managed (grayed out) ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("shell.org_settings_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>
            {t("shell.org_settings_desc")}
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <Alert variant="warning">
          <Lock />
          <AlertDescription>
            {t("shell.org_admin_warning")}
          </AlertDescription>
        </Alert>

        <ToggleRow
          label={t("shell.settings_access")}
          description={t("shell.settings_access_desc")}
          checked={true}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label={t("shell.model_restrictions")}
          description={t("shell.model_restrictions_desc")}
          checked={false}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label={t("shell.extension_restrictions")}
          description={t("shell.extension_restrictions_desc")}
          checked={false}
          onChange={() => {}}
          cloudOnly
        />

        <ToggleRow
          label={t("shell.enable_welcome")}
          description={t("shell.enable_welcome_desc")}
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
          {isDefault ? t("shell.all_defaults") : t("shell.some_customized")}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={resetAll}
          disabled={isDefault}
        >
          <RotateCcw size={12} />
          {t("shell.reset_defaults")}
        </Button>
      </div>
    </LayoutStack>
  );
}
