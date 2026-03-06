import { For, Show } from "solid-js";
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from "lucide-solid";
import { useToasts, ToastType } from "../state/toast";

const icons = {
  success: <CheckCircle2 size={18} class="text-emerald-11" />,
  error: <AlertCircle size={18} class="text-red-11" />,
  info: <Info size={18} class="text-blue-11" />,
  warning: <AlertTriangle size={18} class="text-amber-11" />,
};

const styles = {
  success: "bg-emerald-2 border-emerald-6 shadow-emerald-5/10",
  error: "bg-red-2 border-red-6 shadow-red-5/10",
  info: "bg-blue-2 border-blue-6 shadow-blue-5/10",
  warning: "bg-amber-2 border-amber-6 shadow-amber-5/10",
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToasts();

  return (
    <div class="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none max-w-sm w-full">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={`pointer-events-auto flex items-start gap-3 p-4 rounded-xl border shadow-xl toast-animate-in ${
              styles[toast.type]
            }`}
          >
            <div class="shrink-0 mt-0.5">{icons[toast.type]}</div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-12 leading-snug">
                {toast.message}
              </p>
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              class="shrink-0 text-gray-9 hover:text-gray-12 transition-colors -mt-1 -mr-1 p-1"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
