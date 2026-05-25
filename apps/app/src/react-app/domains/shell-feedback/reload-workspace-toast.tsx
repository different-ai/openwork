/** @jsxImportSource react */
import { RefreshCcw, X } from "lucide-react";

import type { ReloadTrigger } from "../../../app/types";

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

function describeTrigger(
  description: string,
  trigger?: ReloadTrigger | null,
): string {
  if (!trigger) return description;
  const { type, name, action } = trigger;
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
}

export function ReloadWorkspaceToast(props: ReloadWorkspaceToastProps) {
  if (!props.open) return null;

  const message = props.hasActiveRuns
    ? "Reloading will stop active tasks."
    : props.error
      ? props.error
      : describeTrigger(props.description, props.trigger);

  return (
    <div className="fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface px-5 py-3.5 shadow-lg">
        <div className={props.hasActiveRuns ? "text-amber-11" : "text-dls-text"}>
          <RefreshCcw
            size={16}
            className={props.busy ? "animate-spin" : undefined}
          />
        </div>

        <div className="min-w-0 text-[13px] text-dls-text">
          <span className="font-medium">{props.title}</span>{" "}
          <span className={props.error ? "text-red-11" : props.hasActiveRuns ? "text-amber-11" : undefined}>
            {message}
          </span>{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2 transition-colors hover:text-dls-text/80 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => props.onReload()}
            disabled={props.busy || !props.canReload}
          >
            {props.reloadLabel}
          </button>
        </div>

        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={() => props.onDismiss()}
          aria-label={props.dismissLabel}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
