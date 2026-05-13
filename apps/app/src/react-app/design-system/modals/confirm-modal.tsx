/** @jsxImportSource react */
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string | ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "danger" | "warning";
  confirmButtonVariant?: "secondary" | "ghost" | "outline" | "destructive";
  cancelButtonVariant?: "secondary" | "ghost" | "outline" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal(props: ConfirmModalProps) {
  if (!props.open) return null;
  const variant = props.variant ?? "warning";
  const confirmVariant = props.confirmButtonVariant ?? (variant === "danger" ? "destructive" : undefined);
  const cancelVariant = props.cancelButtonVariant ?? "outline";

  const iconTileClass =
    variant === "danger"
      ? "bg-red-3/50 text-red-11"
      : "bg-amber-3/50 text-amber-11";

  return (
    <div className="fixed inset-0 z-[60] bg-gray-1/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-2 border border-gray-6/70 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div
              className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${iconTileClass}`}
            >
              <AlertTriangle size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-gray-12">
                {props.title}
              </h3>
              <p className="mt-2 text-sm text-gray-11">{props.message}</p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant={cancelVariant}
              onClick={props.onCancel}
            >
              {props.cancelLabel}
            </Button>
            <Button
              type="button"
              variant={confirmVariant}
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
