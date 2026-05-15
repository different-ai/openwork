/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { t } from "../../../i18n";
import {
  errorBannerClass,
  modalBodyClass,
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalSubtitleClass,
  modalTitleClass,
  pillGhostClass,
  pillPrimaryClass,
} from "./modal-styles";
import { RemoteWorkspaceFields } from "./remote-workspace-fields";
import type { CreateRemoteWorkspaceModalProps } from "./types";

type RemoteWorkspaceFormState = {
  openworkHostUrl: string;
  openworkToken: string;
  openworkTokenVisible: boolean;
  directory: string;
  displayName: string;
};

const emptyRemoteWorkspaceForm: RemoteWorkspaceFormState = {
  openworkHostUrl: "",
  openworkToken: "",
  openworkTokenVisible: false,
  directory: "",
  displayName: "",
};

export function CreateRemoteWorkspaceModal(
  props: CreateRemoteWorkspaceModalProps,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [form, setForm] = useState<RemoteWorkspaceFormState>(emptyRemoteWorkspaceForm);
  const { openworkHostUrl, openworkToken, openworkTokenVisible, directory, displayName } = form;

  const showClose = props.showClose ?? true;
  const title = props.title ?? t("dashboard.create_remote_workspace_title");
  const subtitle =
    props.subtitle ?? t("dashboard.create_remote_workspace_subtitle");
  const confirmLabel =
    props.confirmLabel ?? t("dashboard.create_remote_workspace_confirm");
  const isInline = props.inline ?? false;
  const submitting = props.submitting ?? false;

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    return openworkHostUrl.trim().length > 0;
  }, [openworkHostUrl, submitting]);

  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const defaults = props.initialValues ?? {};
    setForm({
      openworkHostUrl: defaults.openworkHostUrl?.trim() ?? "",
      openworkToken: defaults.openworkToken?.trim() ?? "",
      openworkTokenVisible: false,
      directory: defaults.directory?.trim() ?? "",
      displayName: defaults.displayName?.trim() ?? "",
    });
  }, [props.initialValues, props.open]);

  if (!props.open && !isInline) {
    return null;
  }

  const content = (
    <div className={`${modalShellClass} max-w-[560px]`}>
      <div className={modalHeaderClass}>
        <div className="min-w-0">
          <h3 className={modalTitleClass}>{title}</h3>
          <p className={modalSubtitleClass}>{subtitle}</p>
        </div>
        {showClose ? (
          <button
            onClick={props.onClose}
            disabled={submitting}
            className={modalHeaderButtonClass}
          >
            <X size={18} />
          </button>
        ) : null}
      </div>

      <div className={modalBodyClass}>
        <RemoteWorkspaceFields
          hostUrl={openworkHostUrl}
          onHostUrlInput={(value) => setForm((current) => ({ ...current, openworkHostUrl: value }))}
          token={openworkToken}
          tokenVisible={openworkTokenVisible}
          onTokenInput={(value) => setForm((current) => ({ ...current, openworkToken: value }))}
          onToggleTokenVisible={() =>
            setForm((current) => ({ ...current, openworkTokenVisible: !current.openworkTokenVisible }))
          }
          displayName={displayName}
          onDisplayNameInput={(value) => setForm((current) => ({ ...current, displayName: value }))}
          directory={directory}
          onDirectoryInput={(value) => setForm((current) => ({ ...current, directory: value }))}
          showDirectory
          submitting={submitting}
          hostInputRef={inputRef}
          title="Remote server details"
          description="Use the URL your OpenWork server shared with you. Add a token only if the server needs one."
        />
      </div>

      <div className="space-y-3 border-t border-dls-border px-6 py-5">
        {props.error ? (
          <div className={errorBannerClass}>{props.error}</div>
        ) : null}
        <div className="flex justify-end gap-3">
          {showClose ? (
            <button
              type="button"
              onClick={props.onClose}
              disabled={submitting}
              className={pillGhostClass}
            >
              {t("common.cancel")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              props.onConfirm({
                openworkHostUrl: openworkHostUrl.trim(),
                openworkToken: openworkToken.trim(),
                directory: directory.trim() ? directory.trim() : null,
                displayName: displayName.trim() ? displayName.trim() : null,
              })
            }
            disabled={!canSubmit}
            title={
              !openworkHostUrl.trim()
                ? t("dashboard.remote_base_url_required")
                : undefined
            }
            className={pillPrimaryClass}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={isInline ? "w-full" : modalOverlayClass}>{content}</div>
  );
}
