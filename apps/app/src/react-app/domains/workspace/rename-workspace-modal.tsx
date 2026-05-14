/** @jsxImportSource react */
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { t } from "../../../i18n";

export type RenameWorkspaceModalProps = {
  open: boolean;
  title: string;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
};

export function RenameWorkspaceModal(props: RenameWorkspaceModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>{t("workspace.rename_title")}</DialogTitle>
          <DialogDescription>{t("workspace.rename_description")}</DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="rename-workspace-title">{t("workspace.rename_label")}</FieldLabel>
          <Input
            ref={inputRef}
            id="rename-workspace-title"
            type="text"
            value={props.title}
            onChange={(event) => props.onTitleChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key === "Process") {
                return;
              }
              if (event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              if (props.canSave) props.onSave();
            }}
            placeholder={t("workspace.rename_placeholder")}
          />
        </Field>

        <DialogFooter>
          <DialogClose
            disabled={props.busy}
            render={<Button variant="outline" type="button" disabled={props.busy} />}
          >
            {t("common.cancel")}
          </DialogClose>
          <Button type="button" onClick={props.onSave} disabled={!props.canSave}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
