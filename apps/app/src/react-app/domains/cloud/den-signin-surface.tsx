/** @jsxImportSource react */
import { ArrowUpRight, Cloud } from "lucide-react";

import { currentLocale, t } from "../../../i18n";
import { DEFAULT_DEN_BASE_URL } from "../../../app/lib/den";
import { Button } from "../../design-system/button";
import { TextInput } from "../../design-system/text-input";

export type DenSignInSurfaceVariant = "panel" | "fullscreen";

export type DenSignInSurfaceProps = {
  variant?: DenSignInSurfaceVariant;
  developerMode: boolean;
  baseUrl: string;
  baseUrlDraft: string;
  baseUrlError: string | null;
  statusMessage: string | null;
  authError: string | null;
  authBusy: boolean;
  baseUrlBusy: boolean;
  sessionBusy: boolean;
  manualAuthOpen: boolean;
  manualAuthInput: string;
  onBaseUrlDraftInput: (value: string) => void;
  onResetBaseUrl: () => void;
  onApplyBaseUrl: () => void;
  onOpenControlPlane: () => void;
  onOpenBrowserAuth: (mode: "sign-in" | "sign-up") => void;
  onToggleManualAuth: () => void;
  onManualAuthInput: (value: string) => void;
  onSubmitManualAuth: () => void;
};

const settingsPanelClass = "ow-soft-card rounded-[28px] p-5 md:p-6";
const settingsPanelSoftClass = "ow-soft-card-quiet rounded-2xl p-4";
const headerBadgeClass =
  "inline-flex min-h-8 items-center gap-2 rounded-xl border border-dls-border bg-dls-hover px-3 text-[13px] font-medium text-dls-text shadow-sm";
const softNoticeClass =
  "rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-dls-secondary";
const errorBannerClass =
  "rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11";

/**
 * React port of the Solid `DenSignInSurface`
 * (`apps/app/src/app/cloud/den-signin-surface.tsx` on dev).
 *
 * Stateless presentation: all state + actions are driven by the parent
 * (ForcedSigninPage for the full-screen gate, or the Den settings panel
 * for the embedded "panel" variant). Matches the Solid contract 1:1 so
 * feature parity is obvious.
 */
export function DenSignInSurface(props: DenSignInSurfaceProps) {
  const tr = (key: string) => t(key, currentLocale());
  const variant: DenSignInSurfaceVariant = props.variant ?? "panel";

  const content = (
    <div className={`${settingsPanelClass} space-y-4`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className={headerBadgeClass}>
            <Cloud size={13} className="text-dls-secondary" />
            {tr("den.cloud_section_title")}
          </div>
          <div>
            <div className="text-sm font-medium text-dls-text">
              {tr("den.signin_title")}
            </div>
          </div>
        </div>
      </div>

      {props.developerMode ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <TextInput
            label={tr("den.cloud_control_plane_url_label")}
            value={props.baseUrlDraft}
            onChange={(event) =>
              props.onBaseUrlDraftInput(event.currentTarget.value)
            }
            placeholder={DEFAULT_DEN_BASE_URL}
            hint={tr("den.cloud_control_plane_url_hint")}
            disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-9 px-3 text-xs"
              onClick={props.onResetBaseUrl}
              disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
            >
              {tr("den.cloud_control_plane_reset")}
            </Button>
            <Button
              variant="secondary"
              className="h-9 px-3 text-xs"
              onClick={props.onApplyBaseUrl}
              disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
            >
              {tr("den.cloud_control_plane_save")}
            </Button>
            <Button
              variant="outline"
              className="h-9 px-3 text-xs"
              onClick={props.onOpenControlPlane}
            >
              {tr("den.cloud_control_plane_open")}
              <ArrowUpRight size={13} />
            </Button>
          </div>
        </div>
      ) : null}

      {props.baseUrlError ? (
        <div className={errorBannerClass}>{props.baseUrlError}</div>
      ) : null}

      {props.statusMessage && !props.authError ? (
        <div className={softNoticeClass}>{props.statusMessage}</div>
      ) : null}

      <div className="space-y-2">
        <div className="max-w-[54ch] text-sm text-dls-secondary">
          {tr("den.auto_reconnect_hint")}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => props.onOpenBrowserAuth("sign-in")}
        >
          {tr("den.signin_button")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          className="h-9 px-3 text-xs"
          onClick={() => props.onOpenBrowserAuth("sign-up")}
        >
          {tr("den.create_account")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          className="h-9 px-3 text-xs"
          onClick={props.onToggleManualAuth}
          disabled={props.authBusy || props.sessionBusy}
        >
          {props.manualAuthOpen
            ? tr("den.hide_signin_code")
            : tr("den.paste_signin_code")}
        </Button>
      </div>

      {props.manualAuthOpen ? (
        <div className={`${settingsPanelSoftClass} space-y-3`}>
          <TextInput
            label={tr("den.signin_link_label")}
            value={props.manualAuthInput}
            onChange={(event) =>
              props.onManualAuthInput(event.currentTarget.value)
            }
            placeholder={tr("den.signin_link_placeholder")}
            disabled={props.authBusy || props.sessionBusy}
            hint={tr("den.signin_link_hint")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              className="h-9 px-3 text-xs"
              onClick={props.onSubmitManualAuth}
              disabled={
                props.authBusy ||
                props.sessionBusy ||
                !props.manualAuthInput.trim()
              }
            >
              {props.authBusy ? tr("den.finishing") : tr("den.finish_signin")}
            </Button>
            <div className="text-[11px] text-dls-secondary">
              {tr("den.signin_code_note")}
            </div>
          </div>
        </div>
      ) : null}

      {props.authError ? (
        <div className={errorBannerClass}>{props.authError}</div>
      ) : null}
    </div>
  );

  if (variant === "fullscreen") {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.12),transparent_42%),linear-gradient(180deg,rgba(248,250,252,1),rgba(241,245,249,0.92))] px-6 py-10 text-dls-text">
        <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl items-center justify-center">
          <div className="w-full space-y-4">{content}</div>
        </div>
      </div>
    );
  }

  return content;
}
