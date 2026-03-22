import { Show, createEffect, createMemo, createSignal } from "solid-js";

import { Globe, X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

export default function CreateRemoteWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => void;
  initialValues?: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  };
  submitting?: boolean;
  error?: string | null;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  let inputRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const [openworkHostUrl, setOpenworkHostUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [directory, setDirectory] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? translate("dashboard.create_remote_workspace_title");
  const subtitle = () => props.subtitle ?? translate("dashboard.create_remote_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? translate("dashboard.create_remote_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;

  const canSubmit = createMemo(() => {
    if (submitting()) return false;
    return openworkHostUrl().trim().length > 0;
  });
  const fieldLabelClass = "px-0.5 text-[13px] font-medium text-dls-text";
  const fieldHintClass = "px-0.5 text-[12px] leading-5 text-dls-secondary";
  const fieldInputClass =
    "w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-sm text-dls-text outline-none transition placeholder:text-dls-secondary focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]";

  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => inputRef?.focus());
    }
  });

  createEffect(() => {
    if (!props.open) return;
    const defaults = props.initialValues ?? {};
    setOpenworkHostUrl(defaults.openworkHostUrl?.trim() ?? "");
    setOpenworkToken(defaults.openworkToken?.trim() ?? "");
    setOpenworkTokenVisible(false);
    setDirectory(defaults.directory?.trim() ?? "");
    setDisplayName(defaults.displayName?.trim() ?? "");
  });

  const content = (
    <div class="flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface">
      <div class="flex items-start justify-between gap-4 border-b border-dls-border bg-dls-surface px-6 py-5">
        <div class="min-w-0">
          <h3 class="text-[18px] font-semibold text-dls-text">{title()}</h3>
          <p class="mt-1 text-sm text-dls-secondary">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class={`flex h-8 w-8 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text ${submitting() ? "cursor-not-allowed opacity-50" : ""}`.trim()}
          >
            <X size={18} />
          </button>
        </Show>
      </div>

      <div class="flex-1 overflow-y-auto px-6 py-6">
        <div class="rounded-xl border border-dls-border bg-dls-sidebar px-5 py-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface text-dls-text">
              <Globe size={17} />
            </div>
            <div class="min-w-0">
              <div class="text-[15px] font-semibold text-dls-text">Remote server details</div>
              <div class="mt-1 text-[13px] leading-6 text-dls-secondary">Use the URL your OpenWork server shared with you. Add a token only if the server needs one.</div>
            </div>
          </div>

          <div class="grid gap-4">
            <label class="grid gap-2">
              <span class={fieldLabelClass}>{translate("dashboard.openwork_host_label")}</span>
              <input
                ref={inputRef}
                type="url"
                value={openworkHostUrl()}
                onInput={(event) => setOpenworkHostUrl(event.currentTarget.value)}
                placeholder={translate("dashboard.openwork_host_placeholder")}
                disabled={submitting()}
                class={fieldInputClass}
              />
              <span class={fieldHintClass}>{translate("dashboard.openwork_host_hint")}</span>
            </label>

            <label class="grid gap-2">
              <span class={fieldLabelClass}>{translate("dashboard.openwork_host_token_label")}</span>
              <div class="flex items-center gap-2 rounded-xl border border-dls-border bg-dls-surface p-1.5">
                <input
                  type={openworkTokenVisible() ? "text" : "password"}
                  value={openworkToken()}
                  onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                  placeholder={translate("dashboard.openwork_host_token_placeholder")}
                  disabled={submitting()}
                  class="min-w-0 flex-1 border-none bg-transparent px-2 py-1.5 text-sm text-dls-text outline-none placeholder:text-dls-secondary"
                />
                <button
                  type="button"
                  class="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                  disabled={submitting()}
                >
                  {openworkTokenVisible() ? translate("common.hide") : translate("common.show")}
                </button>
              </div>
              <span class={fieldHintClass}>{translate("dashboard.openwork_host_token_hint")}</span>
            </label>

            <div class="grid gap-4 md:grid-cols-2">
              <label class="grid gap-2">
                <span class={fieldLabelClass}>{translate("dashboard.remote_directory_label")}</span>
                <input
                  type="text"
                  value={directory()}
                  onInput={(event) => setDirectory(event.currentTarget.value)}
                  placeholder={translate("dashboard.remote_directory_placeholder")}
                  disabled={submitting()}
                  class={fieldInputClass}
                />
                <span class={fieldHintClass}>{translate("dashboard.remote_directory_hint")}</span>
              </label>

              <label class="grid gap-2">
                <span class={fieldLabelClass}>{translate("dashboard.remote_display_name_label")}</span>
                <input
                  type="text"
                  value={displayName()}
                  onInput={(event) => setDisplayName(event.currentTarget.value)}
                  placeholder={translate("dashboard.remote_display_name_placeholder")}
                  disabled={submitting()}
                  class={fieldInputClass}
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="space-y-3 border-t border-dls-border bg-dls-surface px-6 py-5">
        <Show when={props.error}>
          <div class="rounded-lg border border-red-6 bg-red-3/50 p-3 text-sm text-red-11">
            {props.error}
          </div>
        </Show>
        <div class="flex justify-end gap-3">
          <Show when={showClose()}>
            <button
              type="button"
              onClick={props.onClose}
              disabled={submitting()}
              class="rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-center text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {translate("common.cancel")}
            </button>
          </Show>
          <button
            type="button"
            onClick={() =>
              props.onConfirm({
                openworkHostUrl: openworkHostUrl().trim(),
                openworkToken: openworkToken().trim(),
                directory: directory().trim() ? directory().trim() : null,
                displayName: displayName().trim() ? displayName().trim() : null,
              })
            }
            disabled={!canSubmit()}
            title={!openworkHostUrl().trim() ? translate("dashboard.remote_base_url_required") : undefined}
            class="rounded-full bg-dls-accent px-6 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirmLabel()}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div
        class={
          isInline()
            ? "w-full"
            : "fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
