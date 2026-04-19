import { ArrowUpRight, Cloud } from "lucide-solid";
import { Show } from "solid-js";
import { currentLocale, t } from "../../i18n";
import { DEFAULT_DEN_BASE_URL } from "../lib/den";
import Button from "../components/button";
import TextInput from "../components/text-input";

type DenSignInSurfaceProps = {
  variant?: "panel" | "fullscreen";
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

export default function DenSignInSurface(props: DenSignInSurfaceProps) {
  const tr = (key: string) => t(key, currentLocale());
  const variant = () => props.variant ?? "panel";
  const settingsPanelClass = "ow-soft-card rounded-[28px] p-5 md:p-6";
  const settingsPanelSoftClass = "ow-soft-card-quiet rounded-2xl p-4";
  const headerBadgeClass =
    "inline-flex min-h-8 items-center gap-2 rounded-xl border border-dls-border bg-dls-hover px-3 text-[13px] font-medium text-dls-text shadow-sm";
  const softNoticeClass =
    "rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-dls-secondary";

  const content = (
    <div class={`${settingsPanelClass} space-y-4`}>
      <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div class="space-y-2">
          <div class={headerBadgeClass}>
            <Cloud size={13} class="text-dls-secondary" />
            {tr("den.cloud_section_title")}
          </div>
          <div>
            <div class="text-sm font-medium text-dls-text">
              {tr("den.signin_title")}
            </div>
          </div>
        </div>
      </div>

      <Show when={props.developerMode}>
        <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <TextInput
            label={tr("den.cloud_control_plane_url_label")}
            value={props.baseUrlDraft}
            onInput={(event) =>
              props.onBaseUrlDraftInput(event.currentTarget.value)
            }
            placeholder={DEFAULT_DEN_BASE_URL}
            hint={tr("den.cloud_control_plane_url_hint")}
            disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
          />
          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              class="h-9 px-3 text-xs"
              onClick={props.onResetBaseUrl}
              disabled={
                props.authBusy || props.baseUrlBusy || props.sessionBusy
              }
            >
              {tr("den.cloud_control_plane_reset")}
            </Button>
            <Button
              variant="secondary"
              class="h-9 px-3 text-xs"
              onClick={props.onApplyBaseUrl}
              disabled={
                props.authBusy || props.baseUrlBusy || props.sessionBusy
              }
            >
              {tr("den.cloud_control_plane_save")}
            </Button>
            <Button
              variant="outline"
              class="h-9 px-3 text-xs"
              onClick={props.onOpenControlPlane}
            >
              {tr("den.cloud_control_plane_open")}
              <ArrowUpRight size={13} />
            </Button>
          </div>
        </div>
      </Show>

      <Show when={props.baseUrlError}>
        {(value) => (
          <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
            {value()}
          </div>
        )}
      </Show>

      <Show when={props.statusMessage && !props.authError}>
        {(value) => <div class={softNoticeClass}>{value()}</div>}
      </Show>

      <div class="space-y-2">
        <div class="max-w-[54ch] text-sm text-dls-secondary">
          {tr("den.auto_reconnect_hint")}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => props.onOpenBrowserAuth("sign-in")}
        >
          {tr("den.signin_button")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          class="h-9 px-3 text-xs"
          onClick={() => props.onOpenBrowserAuth("sign-up")}
        >
          {tr("den.create_account")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          class="h-9 px-3 text-xs"
          onClick={props.onToggleManualAuth}
          disabled={props.authBusy || props.sessionBusy}
        >
          {props.manualAuthOpen
            ? tr("den.hide_signin_code")
            : tr("den.paste_signin_code")}
        </Button>
      </div>

      <Show when={props.manualAuthOpen}>
        <div class={`${settingsPanelSoftClass} space-y-3`}>
          <TextInput
            label={tr("den.signin_link_label")}
            value={props.manualAuthInput}
            onInput={(event) =>
              props.onManualAuthInput(event.currentTarget.value)
            }
            placeholder={tr("den.signin_link_placeholder")}
            disabled={props.authBusy || props.sessionBusy}
            hint={tr("den.signin_link_hint")}
          />
          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              class="h-9 px-3 text-xs"
              onClick={props.onSubmitManualAuth}
              disabled={
                props.authBusy ||
                props.sessionBusy ||
                !props.manualAuthInput.trim()
              }
            >
              {props.authBusy ? tr("den.finishing") : tr("den.finish_signin")}
            </Button>
            <div class="text-[11px] text-dls-secondary">
              {tr("den.signin_code_note")}
            </div>
          </div>
        </div>
      </Show>

      <Show when={props.authError}>
        {(value) => (
          <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
            {value()}
          </div>
        )}
      </Show>
    </div>
  );

  if (variant() === "fullscreen") {
    return (
      <div class="min-h-screen bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.12),transparent_42%),linear-gradient(180deg,rgba(248,250,252,1),rgba(241,245,249,0.92))] px-6 py-10 text-dls-text">
        <div class="mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl items-center justify-center">
          <div class="w-full space-y-4">{content}</div>
        </div>
      </div>
    );
  }

  return content;
}
