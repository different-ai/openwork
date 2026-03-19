import { Show, type JSX } from "solid-js";

import { AlertTriangle } from "lucide-solid";

import Button from "./button";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmModal(props: ConfirmModalProps) {
  const variant = () => props.variant ?? "warning";

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[60] bg-gray-1/70 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start gap-4">
              <div
                class="shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
                classList={{
                  "bg-amber-3/50 text-amber-11": variant() === "warning",
                  "bg-red-3/50 text-red-11": variant() === "danger",
                }}
              >
                <AlertTriangle size={20} />
              </div>
              <div class="min-w-0">
                <h3 class="text-base font-semibold text-gray-12">{props.title}</h3>
                <p class="mt-2 text-sm text-gray-11">{props.message}</p>
              </div>
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onCancel}>
                {props.cancelLabel}
              </Button>
              <Button
                variant={variant() === "danger" ? "danger" : "primary"}
                onClick={props.onConfirm}
              >
                {props.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
