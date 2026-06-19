/** @jsxImportSource react */
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
import { t } from "@/i18n";

export type RestrictionNoticeModalProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
};

/**
 * React port of the Solid `RestrictionNoticeModal`
 * (`apps/app/src/app/components/restriction-notice-modal.tsx` on dev — added
 * as part of #1505 "enforce desktop restriction policies").
 *
 * Purposefully framework-free except for the shared Button: this is
 * a thin, declarative surface driven by the cloud domain when an org gates
 * a feature (allowZenModel, allowCustomProviders, allowMultipleWorkspaces).
 */
export function RestrictionNoticeModal(props: RestrictionNoticeModalProps) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="flex w-full max-w-lg flex-col overflow-hidden sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {props.title}
          </DialogTitle>
          <DialogDescription>
            {props.message}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose render={<Button />}>
            {t("common.close")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RestrictionNoticeModal;
