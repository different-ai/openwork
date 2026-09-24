/** @jsxImportSource react */
import { Info } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "../../../../i18n";

/**
 * Deleting something the member made. It names who else loses it and, when
 * it is shared, offers the gentler Stop sharing instead.
 */
export function LibraryDeleteDialog(props: {
  open: boolean;
  name: string;
  /** e.g. "Support", or null when nobody else has it. */
  audienceName: string | null;
  audiencePeople: number;
  onCancel: () => void;
  onDelete: () => void;
  onStopSharing: () => void;
}) {
  const shared = props.audienceName !== null;
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => { if (!open) props.onCancel(); }}>
      <AlertDialogContent data-testid="library-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("extensions.delete_title", { name: props.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {shared
              ? t("extensions.delete_body_shared", { audience: props.audienceName ?? "", count: String(props.audiencePeople) })
              : t("extensions.delete_body_just_me")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {shared ? (
          <div className="flex items-start gap-2 rounded-lg bg-dls-hover px-3.5 py-3 text-[13px] text-dls-secondary">
            <Info size={15} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-dls-text">{t("extensions.delete_stop_prompt", { audience: props.audienceName ?? "" })}</p>
              <p>
                {t("extensions.delete_stop_lead")}{" "}
                <button type="button" className="font-medium text-dls-text underline underline-offset-4" onClick={props.onStopSharing}>
                  {t("extensions.delete_stop_link")}
                </button>
              </p>
            </div>
          </div>
        ) : null}
        <AlertDialogFooter className="items-center">
          <p className="me-auto text-xs text-dls-secondary">{t("extensions.edit_undo_note")}</p>
          <AlertDialogCancel variant="outline">{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onDelete}>{t("extensions.delete_confirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
