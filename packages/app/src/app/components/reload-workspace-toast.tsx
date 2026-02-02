import { Show } from "solid-js";
import { AlertTriangle, RefreshCcw, X } from "lucide-solid";

import Button from "./button";
import type { ReloadTrigger } from "../types";

export type ReloadWorkspaceToastProps = {
  open: boolean;
  title: string;
  description: string;
  trigger?: ReloadTrigger | null;
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
  const getDescription = () => {
    if (!props.trigger) return props.description;
    const { type, name, action } = props.trigger;
    const trimmedName = name?.trim();
    const verb =
      action === "removed"
        ? "was removed"
        : action === "added"
        ? "was added"
        : action === "updated"
        ? "was updated"
        : "changed";

    if (type === "skill") {
      return trimmedName
        ? `Skill '${trimmedName}' ${verb}. Reload to use it.`
        : "Skills changed. Reload to apply.";
    }

    if (type === "plugin") {
      return trimmedName
        ? `Plugin '${trimmedName}' ${verb}. Reload to activate.`
        : "Plugins changed. Reload to apply.";
    }

    if (type === "mcp") {
      return trimmedName
        ? `MCP '${trimmedName}' ${verb}. Reload to connect.`
        : "MCP config changed. Reload to apply.";
    }

    if (type === "config") {
      return trimmedName
        ? `Config '${trimmedName}' ${verb}. Reload to apply.`
        : "Config changed. Reload to apply.";
    }

    return "Config changed. Reload to apply.";
  };

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
            
            <Show when={props.description || props.error}>
              <div class="text-xs text-gray-10 truncate leading-none mt-0.5">
                {props.hasActiveRuns 
                  ? <span class="text-amber-11 font-medium">Reloading will stop active tasks.</span>
                  : props.error 
                  ? <span class="text-red-9 font-medium">{props.error}</span>
                  : getDescription()
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
