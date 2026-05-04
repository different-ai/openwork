/** @jsxImportSource react */
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string | ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "danger" | "warning";
  confirmButtonVariant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
  cancelButtonVariant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
};

const buttonBaseClass =
  "inline-flex items-center justify-center rounded-full px-4 py-2 text-[13px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";

const buttonClasses = {
  primary: `${buttonBaseClass} bg-[var(--dls-accent)] text-white hover:bg-[var(--dls-accent-hover)]`,
  secondary: `${buttonBaseClass} bg-gray-12 text-gray-1 hover:bg-gray-11`,
  ghost: `${buttonBaseClass} bg-transparent text-dls-secondary hover:bg-[var(--dls-hover)] hover:text-dls-text`,
  outline: `${buttonBaseClass} border border-dls-border bg-dls-surface text-dls-text hover:bg-[var(--dls-hover)]`,
  danger: `${buttonBaseClass} bg-red-9 text-white hover:bg-red-10`,
} satisfies Record<NonNullable<ConfirmModalProps["confirmButtonVariant"]>, string>;

export function ConfirmModal(props: ConfirmModalProps) {
  if (!props.open) return null;
  const variant = props.variant ?? "warning";
  const confirmVariant = props.confirmButtonVariant ?? (variant === "danger" ? "danger" : "primary");
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
            <button
              type="button"
              className={buttonClasses[cancelVariant]}
              onClick={props.onCancel}
            >
              {props.cancelLabel}
            </button>
            <button
              type="button"
              className={buttonClasses[confirmVariant]}
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
