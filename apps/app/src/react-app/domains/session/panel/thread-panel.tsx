/** @jsxImportSource react */
import * as React from "react";
import { ArrowUpRight, CircleCheck, CircleX, Globe, ListTree, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { handlePanelEscape } from "./panel-empty";
import { useSessionPanelState, type BrowserPanelTab } from "./panel-tab-store";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { useThreadActivity, type ThreadRunStatus } from "./thread-activity";

type ThreadPanelProps = {
  workspaceId: string | null;
  sessionId: string;
  onClose: () => void;
  onOpenSubagentSession?: (sessionId: string) => void;
  onOpenBrowserTab?: (tabId: string) => void;
};

function splitPath(path: string): { name: string; dir: string | null } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  if (separator === -1) return { name: normalized, dir: null };
  return {
    name: normalized.slice(separator + 1),
    dir: normalized.slice(0, separator),
  };
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-green-11">+{additions}</span>
      <span className="text-red-11">−{deletions}</span>
    </span>
  );
}

function SectionHeader({ label, detail }: { label: string; detail?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {detail}
    </div>
  );
}

function RunStatusIcon({ status, exitCode }: { status: ThreadRunStatus; exitCode?: number | null }) {
  if (status === "running") {
    return <Loader2 aria-label="Running" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (status === "failed" || (typeof exitCode === "number" && exitCode !== 0)) {
    return <CircleX aria-label="Failed" className="size-3.5 shrink-0 text-red-11" />;
  }
  return <CircleCheck aria-label="Completed" className="size-3.5 shrink-0 text-muted-foreground" />;
}

export function ThreadPanel({
  workspaceId,
  sessionId,
  onClose,
  onOpenSubagentSession,
  onOpenBrowserTab,
}: ThreadPanelProps) {
  const activity = useThreadActivity(workspaceId, sessionId);
  // Keep the per-session browser tab mirror fresh while this panel is the
  // visible right pane, exactly like the browser panel does.
  useSidePanelTabs(sessionId);
  const { tabs } = useSessionPanelState(sessionId);
  const browserTabs = React.useMemo(
    () => tabs.filter((tab): tab is BrowserPanelTab => tab.type === "browser"),
    [tabs],
  );
  const empty = activity.changes.files.length === 0
    && activity.subagents.length === 0
    && activity.commands.length === 0
    && browserTabs.length === 0;

  return (
    <div
      data-thread-panel={sessionId}
      className="flex h-full flex-col"
      onKeyDownCapture={(event) => {
        if (!handlePanelEscape(event.key, onClose)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3 mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
        <ListTree className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Thread</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {empty ? (
          <p className="px-3 pt-3 text-sm text-muted-foreground">
            File changes, sub-agents, terminal commands, and browser tabs from
            this thread will appear here as the agent works.
          </p>
        ) : null}

        {activity.changes.files.length > 0 ? (
          <section data-thread-changes="">
            <SectionHeader
              label="Changes"
              detail={(
                <span
                  data-thread-additions={activity.changes.additions}
                  data-thread-deletions={activity.changes.deletions}
                >
                  <DiffStat additions={activity.changes.additions} deletions={activity.changes.deletions} />
                </span>
              )}
            />
            <ul className="flex flex-col">
              {activity.changes.files.map((change) => {
                const { name, dir } = splitPath(change.file);
                return (
                  <li
                    key={change.file}
                    data-thread-file={change.file}
                    data-additions={change.additions}
                    data-deletions={change.deletions}
                    className="flex items-center gap-2 px-3 py-1"
                    title={change.file}
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
                      <span className={cn("truncate", change.kind === "deleted" && "line-through opacity-70")}>
                        {name}
                      </span>
                      {dir ? (
                        <span className="min-w-0 truncate text-xs text-muted-foreground/70">{dir}</span>
                      ) : null}
                    </span>
                    <DiffStat additions={change.additions} deletions={change.deletions} />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {activity.subagents.length > 0 ? (
          <section data-thread-subagents="">
            <SectionHeader label="Sub-agents" />
            <ul className="flex flex-col">
              {activity.subagents.map((subagent) => {
                const statusLabel = subagent.status === "running"
                  ? "Working"
                  : subagent.status === "failed"
                    ? "Failed"
                    : "Completed";
                const lines = (
                  <>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn("min-w-0 truncate text-sm", subagent.status === "running" && "ow-text-shimmer")}>
                        {subagent.title}
                      </span>
                      {subagent.childSessionId && onOpenSubagentSession ? (
                        <ArrowUpRight
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground/70">
                      {subagent.agentType} · {statusLabel}
                    </span>
                  </>
                );
                return (
                  <li
                    key={subagent.toolCallId}
                    data-thread-subagent={subagent.toolCallId}
                    data-status={subagent.status}
                  >
                    {subagent.childSessionId && onOpenSubagentSession ? (
                      <button
                        type="button"
                        className="group flex w-full min-w-0 cursor-pointer flex-col gap-0.5 px-3 py-1 text-start transition-colors hover:bg-muted/50"
                        aria-label={`${subagent.title}. Open sub-agent chat`}
                        onClick={() => onOpenSubagentSession(subagent.childSessionId ?? "")}
                      >
                        {lines}
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-col gap-0.5 px-3 py-1">{lines}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {activity.commands.length > 0 ? (
          <section data-thread-terminal="">
            <SectionHeader label="Terminal" />
            <ul className="flex flex-col">
              {activity.commands.map((command) => (
                <li
                  key={command.toolCallId}
                  data-thread-command={command.toolCallId}
                  data-status={command.status}
                  data-exit-code={command.exitCode ?? ""}
                  className="flex items-center gap-2 px-3 py-1"
                  title={command.description ?? command.command}
                >
                  <RunStatusIcon status={command.status} exitCode={command.exitCode} />
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {command.command}
                  </code>
                  {typeof command.exitCode === "number" && command.exitCode !== 0 ? (
                    <span className="shrink-0 font-mono text-xs text-red-11">exit {command.exitCode}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {browserTabs.length > 0 ? (
          <section data-thread-browser="">
            <SectionHeader label="Browser" />
            <ul className="flex flex-col">
              {browserTabs.map((tab) => (
                <li key={tab.id} data-thread-browser-tab={tab.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1 text-start transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
                    aria-label={`Open browser tab: ${tab.label}`}
                    title={tab.url}
                    disabled={!onOpenBrowserTab}
                    onClick={() => onOpenBrowserTab?.(tab.id)}
                  >
                    {tab.favicon ? (
                      <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
                    ) : (
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{tab.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
