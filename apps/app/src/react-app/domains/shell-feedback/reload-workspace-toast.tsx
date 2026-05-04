/** @jsxImportSource react */
import { AlertTriangle, RefreshCcw, X } from "lucide-react";

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

const buttonBaseClass =
  "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass = `${buttonBaseClass} bg-[var(--dls-accent)] text-white hover:bg-[var(--dls-accent-hover)]`;
const dangerButtonClass = `${buttonBaseClass} bg-red-9 text-white hover:bg-red-10`;
const ghostButtonClass = `${buttonBaseClass} border border-transparent bg-transparent text-dls-text hover:bg-[var(--dls-hover)]`;

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

  const bodyHasContent =
    Boolean(props.description) ||
    Boolean(props.error) ||
    Boolean(props.warning) ||
    Boolean(props.blockedReason);

  return (
    <div className="w-full max-w-[24rem] overflow-hidden rounded-[1.4rem] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)] backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-300">
      <div className="flex items-start gap-3 px-4 py-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
            props.hasActiveRuns
              ? "border-amber-6/40 bg-amber-4/80 text-amber-11"
              : "border-sky-6/40 bg-sky-4/80 text-sky-11"
          }`.trim()}
        >
          <RefreshCcw
            size={18}
            className={props.busy ? "animate-spin" : undefined}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-12 truncate">
                  {props.title}
                </span>
                {props.hasActiveRuns ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-4 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-11">
                    Active tasks
                  </span>
                ) : null}
              </div>

              {bodyHasContent ? (
                <div className="mt-1 space-y-1 text-sm leading-relaxed text-gray-10">
                  <div>
                    {props.hasActiveRuns ? (
                      <span className="font-medium text-amber-11">
                        Reloading will stop active tasks.
                      </span>
                    ) : props.error ? (
                      <span className="font-medium text-red-11">
                        {props.error}
                      </span>
                    ) : (
                      describeTrigger(props.description, props.trigger)
                    )}
                  </div>
                  {props.warning ? (
                    <div className="flex items-start gap-2 rounded-2xl border border-amber-6/40 bg-amber-3/70 px-3 py-2 text-xs text-amber-11">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{props.warning}</span>
                    </div>
                  ) : null}
                  {props.blockedReason ? (
                    <div className="text-xs text-gray-9">
                      Blocked: {props.blockedReason}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => props.onDismiss()}
              className="rounded-full p-1 text-gray-9 transition hover:bg-gray-3 hover:text-gray-12"
              aria-label={props.dismissLabel}
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={props.hasActiveRuns ? dangerButtonClass : primaryButtonClass}
              onClick={() => props.onReload()}
              disabled={props.busy || !props.canReload}
            >
              {props.reloadLabel}
            </button>
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => props.onDismiss()}
            >
              {props.dismissLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
