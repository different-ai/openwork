/** @jsxImportSource react */
import {
  ArrowUpRight,
  Cloud,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";

import { t } from "../../../i18n";
import { resolveExtensionIconSrc } from "../../design-system/extension-icon-src";
import { DEFAULT_DEN_BASE_URL } from "../../../app/lib/den";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../design-system/text-input";
import { OrganizationServerAffordance } from "../settings/cloud/organization-server-affordance";
import { SignInFallbackNotice } from "./signin-fallback-notice";

export type DenSignInSurfaceVariant = "panel" | "fullscreen";

export type DenSignInSurfaceProps = {
  variant?: DenSignInSurfaceVariant;
  appName?: string;
  logoUrl?: string | null;
  developerMode: boolean;
  baseUrl: string;
  baseUrlDraft: string;
  baseUrlError: string | null;
  statusMessage: string | null;
  signinFallbackUrl?: string | null;
  authError: string | null;
  authBusy: boolean;
  baseUrlBusy: boolean;
  sessionBusy: boolean;
  manualAuthOpen: boolean;
  manualAuthInput: string;
  organizationServerBusy?: boolean;
  organizationServerError?: string | null;
  organizationServerUrl?: string;
  onBaseUrlDraftInput: (value: string) => void;
  onOrganizationServerSave?: (url: string) => Promise<boolean>;
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

/* ------------------------------------------------------------------ */
/*  Main surface                                                      */
/* ------------------------------------------------------------------ */

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
  const variant: DenSignInSurfaceVariant = props.variant ?? "panel";
  const appName = props.appName?.trim() || "OpenWork";

  /* -- Panel content (reused by both variants) -- */
  const panelContent = (
    <div className={`${settingsPanelClass} space-y-4`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className={headerBadgeClass}>
            <Cloud size={13} className="text-dls-secondary" />
            {t("den.cloud_section_title")}
          </div>
          <div>
            <div className="text-sm font-medium text-dls-text">
              {t("den.signin_title")}
            </div>
          </div>
        </div>
      </div>

      {props.developerMode ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <TextInput
            label={t("den.cloud_control_plane_url_label")}
            value={props.baseUrlDraft}
            onChange={(event) =>
              props.onBaseUrlDraftInput(event.currentTarget.value)
            }
            placeholder={DEFAULT_DEN_BASE_URL}
            hint={t("den.cloud_control_plane_url_hint")}
            disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={props.onResetBaseUrl}
              disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
            >
              {t("den.cloud_control_plane_reset")}
            </Button>
            <Button
              size="sm"
              onClick={props.onApplyBaseUrl}
              disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
            >
              {t("den.cloud_control_plane_save")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={props.onOpenControlPlane}
            >
              {t("den.cloud_control_plane_open")}
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
          {t("den.auto_reconnect_hint")}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => props.onOpenBrowserAuth("sign-in")}>
          {t("den.signin_button")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onOpenBrowserAuth("sign-up")}
        >
          {t("den.create_account")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={props.onToggleManualAuth}
          disabled={props.authBusy || props.sessionBusy}
        >
          {props.manualAuthOpen
            ? t("den.hide_signin_code")
            : t("den.paste_signin_code")}
        </Button>
      </div>

      {props.signinFallbackUrl ? (
        <SignInFallbackNotice url={props.signinFallbackUrl} />
      ) : null}

      {props.manualAuthOpen ? (
        <div className={`${settingsPanelSoftClass} space-y-3`}>
          <TextInput
            label={t("den.signin_link_label")}
            value={props.manualAuthInput}
            onChange={(event) =>
              props.onManualAuthInput(event.currentTarget.value)
            }
            placeholder={t("den.signin_link_placeholder")}
            disabled={props.authBusy || props.sessionBusy}
            hint={t("den.signin_link_hint")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={props.onSubmitManualAuth}
              disabled={
                props.authBusy ||
                props.sessionBusy ||
                !props.manualAuthInput.trim()
              }
            >
              {props.authBusy ? t("den.finishing") : t("den.finish_signin")}
            </Button>
            <div className="text-[11px] text-dls-secondary">
              {t("den.signin_code_note")}
            </div>
          </div>
        </div>
      ) : null}

      {props.authError ? (
        <div className={errorBannerClass}>{props.authError}</div>
      ) : null}
    </div>
  );

  /* ---------------------------------------------------------------- */
  /*  Fullscreen: two-column split layout                             */
  /* ---------------------------------------------------------------- */

  if (variant === "fullscreen") {
    // Paper first-load spec: same centered welcome card as WelcomePage.
    // Forced sign-in only removes the "Use Without Cloud" option.
    return (
      <div className="relative min-h-dvh bg-background text-foreground">
        {/* Pixel-dither mosaic background (dark:invert keeps it visible in dark mode) */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden opacity-[0.1] dark:invert">
          <Dithering
            className="size-full"
            speed={0.01}
            shape="warp"
            type="2x2"
            size={20.3}
            scale={1.19}
            frame={264559.21}
            colorBack="#00000000"
            colorFront="#000000"
          />
        </div>

        {/* Titlebar drag region */}
        <div className="absolute inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

        <div className="relative z-10 flex min-h-dvh items-center justify-center px-6 py-16">
          <div className="w-full max-w-[720px] rounded-3xl border border-border bg-background px-8 pb-12 pt-10 sm:px-16 sm:pb-16 sm:pt-14">
            <div className="flex items-center gap-2.5">
              <img
                src={props.logoUrl ?? resolveExtensionIconSrc("/openwork-mark.svg")}
                alt=""
                width={26}
                height={26}
                className={`max-h-[26px] shrink-0 object-contain object-left ${props.logoUrl ? "" : "dark:invert"}`}
                aria-hidden="true"
              />
              <span className="text-[15px] font-semibold tracking-tight text-foreground">
                {appName}
              </span>
            </div>

            <div className="mt-10 flex flex-col gap-2.5 sm:mt-14">
              <h1 className="text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-foreground sm:text-[38px] sm:leading-[46px]">
                Welcome to {appName}
              </h1>
              <p className="text-[15px] leading-[23px] text-muted-foreground">
                {t("welcome.subtitle")}
              </p>
            </div>

            <div className="mt-11 flex flex-col gap-3">
              <Button
                type="button"
                size="lg"
                className="h-12 w-full text-[15px] font-semibold"
                // Opens on the sign-up tab (label stays "Sign in"): most
                // people hitting this are new, and the web page's tabs let
                // returning users switch to sign-in in one tap.
                onClick={() => props.onOpenBrowserAuth("sign-up")}
                disabled={props.authBusy || props.sessionBusy}
              >
                Sign in to {appName}
                <ArrowUpRight size={15} />
              </Button>

              {props.signinFallbackUrl ? (
                <SignInFallbackNotice url={props.signinFallbackUrl} />
              ) : null}

              {props.onOrganizationServerSave ? (
                <OrganizationServerAffordance
                  busy={props.organizationServerBusy === true}
                  error={props.organizationServerError ?? null}
                  onSave={props.onOrganizationServerSave}
                  url={props.organizationServerUrl ?? props.baseUrl}
                />
              ) : null}

              {props.statusMessage && !props.authError ? (
                <div className={softNoticeClass}>{props.statusMessage}</div>
              ) : null}

              {props.authError ? (
                <div className={errorBannerClass}>{props.authError}</div>
              ) : null}

              {/* Paste code disclosure */}
              <div className="space-y-3">
                <button
                  type="button"
                   className="flex w-full items-center gap-2 rounded-xl border border-dls-border bg-dls-surface/60 px-4 py-2.5 text-left text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-surface"
                  onClick={props.onToggleManualAuth}
                  disabled={props.authBusy || props.sessionBusy}
                >
                  {props.manualAuthOpen ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                  {props.manualAuthOpen
                    ? t("den.hide_signin_code")
                    : t("den.paste_signin_code")}
                </button>

                {props.manualAuthOpen ? (
                  <div className="space-y-3 rounded-xl border border-dls-border bg-dls-surface p-4">
                    <TextInput
                      label={t("den.signin_link_label")}
                      value={props.manualAuthInput}
                      onChange={(event) =>
                        props.onManualAuthInput(event.currentTarget.value)
                      }
                      placeholder={t("den.signin_link_placeholder")}
                      disabled={props.authBusy || props.sessionBusy}
                      hint={t("den.signin_link_hint")}
                    />
                    <button
                      type="button"
                      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-full bg-dls-accent px-4 text-xs font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={props.onSubmitManualAuth}
                      disabled={
                        props.authBusy ||
                        props.sessionBusy ||
                        !props.manualAuthInput.trim()
                      }
                    >
                      {props.authBusy
                        ? t("den.finishing")
                        : t("den.finish_signin")}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Developer mode */}
              {props.developerMode ? (
                <div className="space-y-3 rounded-xl border border-dls-border bg-dls-surface p-4">
                  <TextInput
                    label={t("den.cloud_control_plane_url_label")}
                    value={props.baseUrlDraft}
                    onChange={(event) =>
                      props.onBaseUrlDraftInput(event.currentTarget.value)
                    }
                    placeholder={DEFAULT_DEN_BASE_URL}
                    hint={t("den.cloud_control_plane_url_hint")}
                    disabled={
                      props.authBusy || props.baseUrlBusy || props.sessionBusy
                    }
                  />
                  {props.baseUrlError ? (
                    <div className={errorBannerClass}>{props.baseUrlError}</div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-dls-border bg-dls-surface px-3.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover hover:border-dls-border disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={props.onResetBaseUrl}
                      disabled={
                        props.authBusy || props.baseUrlBusy || props.sessionBusy
                      }
                    >
                      {t("den.cloud_control_plane_reset")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-dls-accent px-3.5 text-xs font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={props.onApplyBaseUrl}
                      disabled={
                        props.authBusy || props.baseUrlBusy || props.sessionBusy
                      }
                    >
                      {t("den.cloud_control_plane_save")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Panel variant (settings embed): unchanged                       */
  /* ---------------------------------------------------------------- */

  return panelContent;
}
