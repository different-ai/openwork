import { Show, createEffect, createMemo, createSignal } from "solid-js";

import { X } from "lucide-solid";

import { t } from "../../i18n";
import {
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalTitleClass,
  modalSubtitleClass,
  modalBodyClass,
  pillGhostClass,
  pillPrimaryClass,
  errorBannerClass,
} from "./modal-styles";
import RemoteWorkspaceFields from "./remote-workspace-fields";
import type { CreateRemoteWorkspaceModalProps } from "./types";

export default function CreateRemoteWorkspaceModal(props: CreateRemoteWorkspaceModalProps) {
  let inputRef: HTMLInputElement | undefined;

  const [openworkHostUrl, setOpenworkHostUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [directory, setDirectory] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? t("dashboard.create_remote_workspace_title");
  const subtitle = () => props.subtitle ?? t("dashboard.create_remote_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? t("dashboard.create_remote_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;

  const canSubmit = createMemo(() => {
    if (submitting()) return false;
    return openworkHostUrl().trim().length > 0;
  });

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
    <div class={`${modalShellClass} max-w-[560px]`}>
      <div class={modalHeaderClass}>
        <div class="min-w-0">
          <h3 class={modalTitleClass}>{title()}</h3>
          <p class={modalSubtitleClass}>{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class={modalHeaderButtonClass}
          >
            <X size={18} />
          </button>
        </Show>
      </div>

      <div class={modalBodyClass}>
        <RemoteWorkspaceFields
          hostUrl={openworkHostUrl()}
          onHostUrlInput={setOpenworkHostUrl}
          token={openworkToken()}
          tokenVisible={openworkTokenVisible()}
          onTokenInput={setOpenworkToken}
          onToggleTokenVisible={() => setOpenworkTokenVisible((prev) => !prev)}
          displayName={displayName()}
          onDisplayNameInput={setDisplayName}
          directory={directory()}
          onDirectoryInput={setDirectory}
          showDirectory={true}
          submitting={submitting()}
          hostInputRef={inputRef}
          title="Remote server details"
          description="Use the URL your OpenWork server shared with you. Add a token only if the server needs one."
        />
      </div>

      <div class="space-y-3 border-t border-dls-border px-6 py-5">
        <Show when={props.error}>
          <div class={errorBannerClass}>{props.error}</div>
        </Show>
        <div class="flex justify-end gap-3">
          <Show when={showClose()}>
            <button
              type="button"
              onClick={props.onClose}
              disabled={submitting()}
              class={pillGhostClass}
            >
              {t("common.cancel")}
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
            title={!openworkHostUrl().trim() ? t("dashboard.remote_base_url_required") : undefined}
            class={pillPrimaryClass}
          >
            {confirmLabel()}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div class={isInline() ? "w-full" : modalOverlayClass}>{content}</div>
    </Show>
  );
}
