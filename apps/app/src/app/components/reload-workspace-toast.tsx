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

    if (type === "agent") {
      return trimmedName
        ? `Agent '${trimmedName}' ${verb}. Reload to use it.`
        : "Agents changed. Reload to apply.";
    }

    if (type === "command") {
      return trimmedName
        ? `Command '${trimmedName}' ${verb}. Reload to use it.`
        : "Commands changed. Reload to apply.";
    }

    return "Config changed. Reload to apply.";
  };

  return (
    <Show when={props.open}>
      <div class="w-full max-w-[24rem] overflow-hidden rounded-[1.4rem] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)] backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-300">
        <div class="flex items-start gap-3 px-4 py-4">
          <div
            class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
              props.hasActiveRuns
                ? "border-amber-6/40 bg-amber-4/80 text-amber-11"
                : "border-sky-6/40 bg-sky-4/80 text-sky-11"
            }`.trim()}
          >
            <RefreshCcw size={18} class={props.busy ? "animate-spin" : ""} />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-gray-12 truncate">{props.title}</span>
                  <Show when={props.hasActiveRuns}>
                    <span class="inline-flex items-center gap-1 rounded-full bg-amber-4 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-11">
                      Active tasks
                    </span>
                  </Show>
                </div>

                <Show when={props.description || props.error || props.warning || props.blockedReason}>
                  <div class="mt-1 space-y-1 text-sm leading-relaxed text-gray-10">
                    <div>
                      {props.hasActiveRuns ? (
                        <span class="font-medium text-amber-11">Reloading will stop active tasks.</span>
                      ) : props.error ? (
                        <span class="font-medium text-red-11">{props.error}</span>
                      ) : (
                        getDescription()
                      )}
                    </div>
                    <Show when={props.warning}>
                      <div class="flex items-start gap-2 rounded-2xl border border-amber-6/40 bg-amber-3/70 px-3 py-2 text-xs text-amber-11">
                        <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                        <span>{props.warning}</span>
                      </div>
                    </Show>
                    <Show when={props.blockedReason}>
                      <div class="text-xs text-gray-9">Blocked: {props.blockedReason}</div>
                    </Show>
                  </div>
                </Show>
              </div>

              <button
                type="button"
                onClick={() => props.onDismiss()}
                class="rounded-full p-1 text-gray-9 transition hover:bg-gray-3 hover:text-gray-12"
                aria-label={props.dismissLabel}
              >
                <X size={16} />
              </button>
            </div>

            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={props.hasActiveRuns ? "danger" : "primary"}
                class="rounded-full px-3 py-1.5 text-xs"
                onClick={() => props.onReload()}
                disabled={props.busy || !props.canReload}
              >
                {props.reloadLabel}
              </Button>
              <Button variant="ghost" class="rounded-full px-3 py-1.5 text-xs" onClick={() => props.onDismiss()}>
                {props.dismissLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
