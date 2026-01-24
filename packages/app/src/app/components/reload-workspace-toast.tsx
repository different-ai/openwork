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
  hasActiveRuns: boolean;
  onReload: () => void;
  onDismiss: () => void;
};

export default function ReloadWorkspaceToast(props: ReloadWorkspaceToastProps) {
  return (
    <Show when={props.open}>
      <div class="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[min(480px,calc(100vw-2rem))]">
        <div 
          class="
            flex items-center gap-3 p-2 pr-3 rounded-full 
            border border-gray-6/50 bg-gray-2/95 shadow-xl backdrop-blur-md 
            animate-in fade-in slide-in-from-top-4 duration-300
          "
        >
          {/* Icon Circle */}
          <div class={`
            flex h-9 w-9 shrink-0 items-center justify-center rounded-full 
            ${props.hasActiveRuns ? 'bg-amber-3 text-amber-11' : 'bg-blue-3 text-blue-11'}
          `}>
            <RefreshCcw size={16} class={props.busy ? "animate-spin" : ""} />
          </div>

          {/* Text Content */}
          <div class="flex-1 min-w-0 flex flex-col justify-center">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-gray-12 truncate">
                {props.title}
              </span>
              <Show when={props.hasActiveRuns}>
                <span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-amber-4 text-amber-11">
                  Active Tasks
                </span>
              </Show>
            </div>
            
            <Show when={props.description}>
              <div class="text-xs text-gray-10 truncate leading-none mt-0.5">
                {props.hasActiveRuns 
                  ? <span class="text-amber-11 font-medium">Reloading will stop active tasks.</span>
                  : props.description
                }
              </div>
            </Show>
          </div>

          {/* Actions */}
          <div class="flex items-center gap-2 shrink-0 pl-2 border-l border-gray-5/50">
             <button 
              onClick={() => props.onDismiss()}
              class="px-2 py-1.5 text-xs font-medium text-gray-10 hover:text-gray-12 transition-colors"
            >
              {props.dismissLabel}
            </button>
            <Button
              variant={props.hasActiveRuns ? "danger" : "primary"}
              class="h-7 px-3 text-xs rounded-full font-medium"
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
