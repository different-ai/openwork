/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, RefreshCw, Search, Send, Square, SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import type { CodeSessionDriveRun, CodeSessionSummary } from "@/app/lib/code-sessions";
import { CODE_SESSION_CLIENT_LABELS } from "@/app/lib/code-sessions";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { cn } from "@/lib/utils";
import { CodeTranscript } from "./code-transcript";

const DRIVE_EFFORTS = ["low", "medium", "high"] as const;

const LIST_REFETCH_MS = 5_000;
const DETAIL_REFETCH_MS = 4_000;

/** "5 min ago" style labels; sessions are compared against a fresh clock. */
function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(1, Math.round((now - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 60) return formatter.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}

function folderOf(projectPath: string): string {
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

type ProjectGroup = { projectPath: string; items: CodeSessionSummary[] };

function groupByProject(items: CodeSessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const item of items) {
    const group = groups.get(item.projectPath);
    if (group) group.items.push(item);
    else groups.set(item.projectPath, { projectPath: item.projectPath, items: [item] });
  }
  return [...groups.values()];
}

function SessionRow({
  item,
  active,
  now,
  onSelect,
}: {
  item: CodeSessionSummary;
  active: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex h-12 w-full items-center gap-3 rounded-md px-3 text-left",
        active ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-foreground">{item.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {folderOf(item.projectPath)} · {relativeTime(item.updatedAt, now)}
        </span>
      </span>
    </button>
  );
}

export function CodePage({ openworkServerClient: client }: { openworkServerClient: OpenworkServerClient | null }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("session"));
  const [now, setNow] = useState(() => Date.now());

  // ?session=<id> deep-links a transcript; following the link replaces the
  // selection instead of fighting it.
  const linkedSessionId = new URLSearchParams(location.search).get("session");
  useEffect(() => {
    if (linkedSessionId) setSelectedId(linkedSessionId);
  }, [linkedSessionId]);

  const listQuery = useQuery({
    queryKey: ["code-sessions"],
    queryFn: () => {
      if (!client) throw new Error("The OpenWork server is not connected yet.");
      return client.listCodeSessions();
    },
    enabled: Boolean(client),
    refetchInterval: LIST_REFETCH_MS,
  });

  const [draft, setDraft] = useState("");
  const [activeDriveId, setActiveDriveId] = useState<string | null>(null);
  const [driveModel, setDriveModel] = useState("");
  const [driveAgent, setDriveAgent] = useState("");
  const [driveEffort, setDriveEffort] = useState("");
  const drivesQuery = useQuery({
    queryKey: ["code-session-drives"],
    queryFn: () => {
      if (!client) throw new Error("The OpenWork server is not connected yet.");
      return client.listCodeSessionDrives();
    },
    enabled: Boolean(client),
    // While anything runs the turn streams into the transcript through the
    // mirror poll; the drive poll only tracks the running flag.
    refetchInterval: (query) => {
      const runs = query.state.data ?? [];
      return runs.some((run) => run.status === "running") ? 2_000 : false;
    },
  });
  const drives = drivesQuery.data ?? [];
  const activeDrive: CodeSessionDriveRun | null = useMemo(() => {
    if (!selectedId) return null;
    const run = drives.find((entry) => entry.sessionId === selectedId && entry.status === "running");
    return run ?? null;
  }, [drives, selectedId]);
  useEffect(() => {
    if (activeDriveId && activeDrive && activeDrive.id !== activeDriveId) setActiveDriveId(activeDrive.id);
  }, [activeDrive, activeDriveId]);

  const items = listQuery.data?.items ?? [];
  const clients = listQuery.data?.clients ?? [];
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      item.title.toLowerCase().includes(query) || item.projectPath.toLowerCase().includes(query),
    );
  }, [filter, items]);
  const groups = useMemo(() => groupByProject(filtered), [filtered]);

  const selected = items.find((item) => item.sessionId === selectedId) ?? null;

  const catalogQuery = useQuery({
    queryKey: ["code-session-catalog", selected?.client ?? "", selected?.projectPath ?? ""],
    queryFn: () => {
      if (!client || !selected) throw new Error("not connected");
      return client.getCodeSessionCatalog(selected.client, selected.projectPath);
    },
    enabled: Boolean(client && selected && (selected.client === "claude-code" || selected.client === "opencode" || selected.client === "codex")),
    staleTime: 60_000,
  });

  const detailQuery = useQuery({
    queryKey: ["code-session", selectedId],
    queryFn: () => {
      if (!client || !selected) {
        throw new Error("This session is no longer listed.");
      }
      return client.readCodeSession(selected.client, selected.sessionId);
    },
    enabled: Boolean(client && selected),
    refetchInterval: DETAIL_REFETCH_MS,
  });

  // The list clock only moves on a slow tick, so relative labels stay fresh
  // without re-rendering the transcript on every list poll.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const activeRun = useMemo(
    () => drives.find((entry) => entry.id === activeDriveId) ?? null,
    [activeDriveId, drives],
  );
  const prevDriveStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = activeRun?.status ?? null;
    if (prevDriveStatusRef.current === "running" && status !== null && status !== "running") {
      void queryClient.invalidateQueries({ queryKey: ["code-sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["code-session", selectedId] });
    }
    prevDriveStatusRef.current = status;
  }, [activeRun?.status, queryClient, selectedId]);

  const toggleClient = async (id: string, enabled: boolean) => {
    if (!client) return;
    try {
      await client.setCodeSessionClientEnabled(id, enabled);
      await queryClient.invalidateQueries({ queryKey: ["code-sessions"] });
      if (!enabled) setSelectedId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The coding agent could not be switched.");
    }
  };

  const driveRunning = activeDrive !== null;
  const sendPrompt = async () => {
    if (!client || !selected || driveRunning) return;
    const prompt = draft.trim();
    if (!prompt) return;
    try {
      const run = await client.startCodeSessionDrive(selected.client, selected.sessionId, prompt, {
        model: driveModel || undefined,
        agent: driveAgent || undefined,
        // Effort is Claude-only at the CLI level; OpenCode's model config governs it.
        effort: selected.client === "claude-code" ? (driveEffort || undefined) : undefined,
      });
      setActiveDriveId(run.id);
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: ["code-session-drives"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The prompt could not be started.");
    }
  };

  const abortDrive = async () => {
    if (!client || !activeDrive) return;
    try {
      await client.abortCodeSessionDrive(activeDrive.id);
      await queryClient.invalidateQueries({ queryKey: ["code-session-drives"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The run could not be stopped.");
    }
  };

  const clientsRow = clients.length > 0 ? (
    <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 px-1">
      {clients.map((entry) => (
        <label key={entry.id} className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={CODE_SESSION_CLIENT_LABELS[entry.id] ?? entry.id}>
            {CODE_SESSION_CLIENT_LABELS[entry.id] ?? entry.id}
          </span>
          <Switch
            checked={entry.enabled}
            disabled={!entry.available}
            aria-label={`Mirror ${entry.id} sessions`}
            onCheckedChange={(value) => void toggleClient(entry.id, value === true)}
          />
        </label>
      ))}
    </div>
  ) : null;

  if (!client) {
    return (
      <Empty variant="ghost" className="h-full">
        <EmptyHeader>
          <EmptyTitle>The OpenWork server is not connected</EmptyTitle>
          <EmptyDescription>Connect a workspace first; the Code tab reads its sessions from the same server.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full w-80 min-w-0 shrink-0 flex-col border-r border-border">
        <div className="flex flex-col gap-3 border-b border-border px-3 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search sessions"
              aria-label="Search sessions"
              className="h-8 pl-8"
            />
          </div>
          {clientsRow}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-code-session-list>
          {listQuery.isPending ? (
            <div className="flex flex-col gap-2 px-1 pt-1">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : listQuery.isError ? (
            <div className="flex flex-col items-start gap-2 px-2 py-4">
              <p className="text-sm text-muted-foreground">
                The session list could not be read. The server may still be starting.
              </p>
              <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
                <RefreshCw className="size-3.5" aria-hidden />
                Retry
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <Empty variant="ghost">
              <EmptyHeader>
                <EmptyMedia>
                  <SquareTerminal className="size-6 text-muted-foreground" aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No sessions mirrored yet</EmptyTitle>
                <EmptyDescription>
                  {clients.every((entry) => !entry.enabled)
                    ? "Turn a coding agent on above to mirror its sessions."
                    : "Run Claude Code in any project on this computer; its sessions appear here."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            groups.map((group) => (
              <div key={group.projectPath} className="mb-3">
                <p className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted-foreground">
                  <Folder className="size-3.5" aria-hidden />
                  <span className="truncate">{folderOf(group.projectPath)}</span>
                  <span className="truncate font-normal" title={group.projectPath}>{group.projectPath !== folderOf(group.projectPath) ? group.projectPath : null}</span>
                </p>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <SessionRow
                      key={item.sessionId}
                      item={item}
                      active={item.sessionId === selectedId}
                      now={now}
                      onSelect={() => {
                        setNow(Date.now());
                        setSelectedId(item.sessionId);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto" data-code-transcript-pane>
        {selected && detailQuery.data ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
            <header className="flex flex-col gap-1">
              <h2 className="truncate text-base font-semibold text-foreground">{detailQuery.data.summary.title}</h2>
              <p className="text-xs text-muted-foreground">
                {CODE_SESSION_CLIENT_LABELS[selected.client] ?? selected.client}
                {" · "}
                {selected.projectPath}
                {" · "}
                {relativeTime(detailQuery.data.summary.updatedAt, now)}
                {" · External, read-only"}
              </p>
            </header>
            {detailQuery.data.notes.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {detailQuery.data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            <CodeTranscript messages={detailQuery.data.messages} />
            {selected.client === "claude-code" || selected.client === "opencode" || selected.client === "codex" ? (
              <div className="mt-2 flex flex-col gap-2 rounded-[16px] border border-border bg-background p-2">
                {catalogQuery.data ? (
                  <div className="flex flex-wrap items-center gap-2 px-1" data-code-drive-selects>
                    <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="shrink-0">Model</span>
                      <select
                        value={driveModel}
                        onChange={(event) => setDriveModel(event.target.value)}
                        className="h-6 rounded-md border border-border bg-background px-1 text-[11px] text-foreground"
                        aria-label="Model for driven runs"
                      >
                        <option value="">Session default</option>
                        {catalogQuery.data.models.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    </label>
                    <label
                      className={cn("flex min-w-0 items-center gap-1.5 text-[11px]", catalogQuery.data.effort === "unsupported" ? "text-muted-foreground/60" : "text-muted-foreground")}
                      title={catalogQuery.data.effort === "unsupported" ? "This client has no effort flag on its run CLI" : undefined}
                    >
                      <span className="shrink-0">Effort</span>
                      <select
                        value={driveEffort}
                        onChange={(event) => setDriveEffort(event.target.value)}
                        disabled={catalogQuery.data.effort === "unsupported"}
                        className="h-6 rounded-md border border-border bg-background px-1 text-[11px] text-foreground disabled:opacity-60"
                        aria-label="Thinking effort for driven runs"
                      >
                        <option value="">Default</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                    <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="shrink-0">Agent</span>
                      <select
                        value={driveAgent}
                        onChange={(event) => setDriveAgent(event.target.value)}
                        className="h-6 rounded-md border border-border bg-background px-1 text-[11px] text-foreground"
                        aria-label="Agent modality for driven runs"
                      >
                        <option value="">Default</option>
                        {catalogQuery.data.agents.map((agent) => (
                          <option key={agent} value={agent}>{agent}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                {driveRunning ? (
                  <p className="px-1 text-xs text-muted-foreground" data-code-drive-running>
                    {CODE_SESSION_CLIENT_LABELS[selected.client]} is working on this session — the reply lands here as it writes it.
                  </p>
                ) : null}
                {catalogQuery.data && (catalogQuery.data.models.length > 0 || catalogQuery.data.agents.length > 0) ? (
                  <div className="flex flex-wrap items-center gap-2 px-1" data-code-drive-selects>
                    {catalogQuery.data.models.length > 0 ? (
                      <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="shrink-0">Model</span>
                        <select
                          value={driveModel}
                          onChange={(event) => setDriveModel(event.target.value)}
                          disabled={driveRunning}
                          aria-label="Model for the driven run"
                          className="h-7 max-w-44 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                        >
                          <option value="">Agent default</option>
                          {catalogQuery.data.models.map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {selected.client === "claude-code" ? (
                      <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title="Applies MAX_THINKING_TOKENS to the driven run">
                        <span className="shrink-0">Thinking</span>
                        <select
                          value={driveEffort}
                          onChange={(event) => setDriveEffort(event.target.value)}
                          disabled={driveRunning}
                          aria-label="Thinking effort for the driven run"
                          className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                        >
                          <option value="">Default</option>
                          {DRIVE_EFFORTS.map((effort) => (
                            <option key={effort} value={effort}>{effort}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {catalogQuery.data.agents.length > 0 ? (
                      <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="shrink-0">Agent</span>
                        <select
                          value={driveAgent}
                          onChange={(event) => setDriveAgent(event.target.value)}
                          disabled={driveRunning}
                          aria-label="Agent modality for the driven run"
                          className="h-7 max-w-44 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                        >
                          <option value="">Default</option>
                          {catalogQuery.data.agents.map((agent) => (
                            <option key={agent} value={agent}>{agent}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                ) : null}
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt();
                    }
                  }}
                  placeholder={`Write to ${CODE_SESSION_CLIENT_LABELS[selected.client] ?? selected.client}…`}
                  aria-label={`Write to ${CODE_SESSION_CLIENT_LABELS[selected.client] ?? selected.client}`}
                  disabled={driveRunning}
                  className="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0"
                />
                <div className="flex items-center justify-end gap-2">
                  {driveRunning ? (
                    <Button variant="outline" size="sm" onClick={() => void abortDrive()}>
                      <Square className="size-3.5" aria-hidden />
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" disabled={!draft.trim()} onClick={() => void sendPrompt()}>
                      <Send className="size-3.5" aria-hidden />
                      Send
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="rounded-[16px] border border-border px-4 py-3 text-xs text-muted-foreground" data-code-drive-locked>
                Writing to {CODE_SESSION_CLIENT_LABELS[selected.client] ?? selected.client} arrives client by client; this session is read-only for now.
              </p>
            )}
          </div>
        ) : selected && detailQuery.isError ? (
          <Empty variant="ghost" className="h-full">
            <EmptyHeader>
              <EmptyTitle>This session could not be read</EmptyTitle>
              <EmptyDescription>It may have been deleted by the coding agent while you were opening it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : selected ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          <Empty variant="ghost" className="h-full">
            <EmptyHeader>
              <EmptyTitle>Choose a session</EmptyTitle>
              <EmptyDescription>Read any Claude Code session on this computer without leaving OpenWork.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
