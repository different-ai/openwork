/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";
import {
  errorBannerClass,
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

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={showClose}
        className="flex max-h-[90vh] min-h-0 w-full max-w-xl flex-col overflow-hidden sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
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

        <DialogFooter className="shrink-0 flex-col gap-3">
          {props.error ? (
            <div className={errorBannerClass}>{props.error}</div>
          ) : null}
          <div className="flex justify-end gap-3">
            {showClose ? (
              <DialogClose
                disabled={submitting}
                render={<Button variant="outline" disabled={submitting} />}
              >
                {t("common.cancel")}
              </DialogClose>
            ) : null}
            <Button
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
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
