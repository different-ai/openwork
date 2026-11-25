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
