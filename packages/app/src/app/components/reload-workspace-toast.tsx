import { Show } from "solid-js";
import { AlertTriangle, RefreshCcw, X } from "lucide-solid";

import Button from "./button";

export type ReloadWorkspaceToastProps = {
  open: boolean;
  title: string;
  description: string;
  warning?: string;
  blockedReason?: string | null;
  error?: string | null;
  reloadLabel: string;
  dismissLabel: string;
  busy?: boolean;
  canReload: boolean;
  onReload: () => void;
  onDismiss: () => void;
};

export default function ReloadWorkspaceToast(props: ReloadWorkspaceToastProps) {
  return (
    <Show when={props.open}>
      <div class="fixed top-6 right-6 z-50 w-[min(380px,calc(100vw-2rem))]">
        <div class="group relative overflow-hidden rounded-xl border border-gray-6/50 bg-gray-1/95 p-4 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-4 duration-300">
          
          {/* Status Bar */}
          <div class="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-blue-9 to-indigo-9 opacity-80" />

          <button 
            onClick={() => props.onDismiss()}
            class="absolute top-3 right-3 text-gray-8 hover:text-gray-11 transition-colors"
          >
            <X size={14} />
          </button>

          <div class="flex items-start gap-3 pt-1">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-3 text-gray-11 ring-1 ring-black/5">
              <RefreshCcw size={18} class={props.busy ? "animate-spin" : ""} />
            </div>
            
            <div class="flex-1 space-y-1">
              <div class="font-medium text-gray-12 leading-tight pr-4">{props.title}</div>
              <div class="text-xs text-gray-10 leading-relaxed">{props.description}</div>
              
              <Show when={props.error}>
                <div class="mt-2 flex items-start gap-1.5 rounded-md bg-red-2 px-2 py-1.5 text-xs text-red-11">
                  <AlertTriangle size={12} class="mt-0.5 shrink-0" />
                  <span>{props.error}</span>
                </div>
              </Show>

              <Show when={!props.error && (props.warning || props.blockedReason)}>
                 <div class="mt-2 flex items-start gap-1.5 rounded-md bg-amber-2 px-2 py-1.5 text-xs text-amber-11">
                  <AlertTriangle size={12} class="mt-0.5 shrink-0" />
                  <span>{props.blockedReason || props.warning}</span>
                </div>
              </Show>
            </div>
          </div>

          <div class="mt-4 flex justify-end gap-2">
            <Button
              variant="primary"
              class="h-7 px-4 text-xs font-medium w-full sm:w-auto"
              onClick={() => props.onReload()}
              disabled={props.busy || !props.canReload}
            >
              {props.reloadLabel}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
