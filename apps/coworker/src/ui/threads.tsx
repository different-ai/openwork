import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import {
  artifactKindLabel,
  artifactsForToolCall,
  type CoworkerArtifactKind,
} from "@/lib/artifacts";
import {
  createCoworkerMcpClient,
  gatewayMcpAppLaunch,
  preservedMcpAppResult,
  type CoworkerMcpAppResource,
  type CoworkerMcpClient,
  type PreservedMcpAppResult,
} from "@/lib/mcp";
import {
  createCoworkerThreads,
  describeInteractions,
  hasPendingInteractions,
  type PendingInteractions,
  type ThreadListItem,
} from "@/lib/threads";
import { InteractionCards } from "@/ui/interactions";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { InlineLoader } from "@/ui/brand";
import { Button, Empty, ErrorNote, StatusDot } from "@/ui/kit";
import { McpAppFrame } from "@/ui/mcp-app-frame";

type TranscriptToolCall = {
  partId: string;
  tool: string;
  status: string;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  metadata: Record<string, unknown>;
};

type TranscriptMessage = {
  id: string;
  role: string;
  text: string;
  toolCalls: TranscriptToolCall[];
};

export type AssignmentDraft = { id: number; text: string } | null;

const STARTERS = [
  "Review your workspace and tell me what needs my attention.",
  "Summarize what you are focused on and propose the next three steps.",
  "Turn this outcome into a short plan, then start the first safe step.",
];

function relativeTime(timestamp: number): string {
  if (!timestamp) return "Not started";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function threadTone(status: ThreadListItem["status"]): "spark" | "amber" | "mint" {
  if (status === "busy") return "spark";
  if (status === "retry") return "amber";
  return "mint";
}

export function ThreadsPanel({
  runtime,
  coworker,
  onCoworkerChanged,
  onRefreshRuntime,
  assignmentDraft,
}: {
  runtime: RuntimeInfo;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onRefreshRuntime: () => Promise<void>;
  assignmentDraft?: AssignmentDraft;
}) {
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
            model: coworker.model,
            modelVariant: coworker.modelVariant,
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model, coworker.modelVariant],
  );
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [attentionBySession, setAttentionBySession] = useState<Record<string, string>>({});
  const [openThreadId, setOpenThreadId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (assignmentDraft) setOpenThreadId("");
  }, [assignmentDraft]);

  const refresh = useCallback(async () => {
    if (!threads) return;
    try {
      const [list, pending] = await Promise.all([
        threads.listThreads(),
        threads.listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] })),
      ]);
      setItems(list);
      const attention: Record<string, string> = {};
      for (const permission of pending.permissions) {
        attention[permission.sessionID] ??= describeInteractions({ permissions: [permission], questions: [] });
      }
      for (const question of pending.questions) {
        attention[question.sessionID] ??= describeInteractions({ permissions: [], questions: [question] });
      }
      setAttentionBySession(attention);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threads]);

  useEffect(() => {
    void refresh();
    if (!threads) return;
    const unsubscribe = threads.subscribe(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [threads, refresh]);

  if (!threads) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-4 text-center">
          <Empty>This coworker needs a workspace before it can start.</Empty>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button
            variant="primary"
            onClick={() => {
              void (async () => {
                try {
                  const repaired = await coworkerBridge.coworkers.ensureWorkspace(coworker.slug);
                  await onRefreshRuntime();
                  onCoworkerChanged(repaired);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              })();
            }}
          >
            Prepare workspace
          </Button>
        </div>
      </div>
    );
  }

  if (openThreadId) {
    return (
      <ThreadView
        key={openThreadId}
        threads={threads}
        threadId={openThreadId}
        coworker={coworker}
        runtime={runtime}
        onBack={() => {
          setOpenThreadId("");
          void refresh();
        }}
      />
    );
  }

  return (
    <WorkOverview
      coworker={coworker}
      error={error}
      items={items}
      attentionBySession={attentionBySession}
      onOpen={setOpenThreadId}
      threads={threads}
      assignmentDraft={assignmentDraft}
    />
  );
}

function WorkOverview({
  threads,
  coworker,
  items,
  attentionBySession,
  error,
  onOpen,
  assignmentDraft,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  coworker: CoworkerSummary;
  items: ThreadListItem[];
  attentionBySession: Record<string, string>;
  error: string;
  onOpen: (threadId: string) => void;
  assignmentDraft?: AssignmentDraft;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignError, setAssignError] = useState("");

  useEffect(() => {
    if (assignmentDraft) setPrompt(assignmentDraft.text);
  }, [assignmentDraft]);

  async function assign() {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setAssignError("");
    try {
      const title = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      const thread = await threads.client.createThread({ title, prompt: text });
      setPrompt("");
      onOpen(thread.id);
    } catch (cause) {
      setAssignError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <div>
          <h2 className="text-sm font-semibold text-snow">Work with {coworker.name}</h2>
          <p className="text-xs text-mist">One assignment becomes a durable OpenWork thread.</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {items.length === 0 && !error ? (
          <div className="mx-auto flex h-full max-w-xl flex-col justify-center py-8 text-center">
            <CoworkerAvatar
              animated
              color={coworker.avatarColor}
              glasses={coworker.avatarGlasses}
              name={coworker.name}
              size={88}
            />
            <h3 className="mt-2 text-lg font-semibold text-snow">What should {coworker.name} own next?</h3>
            <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-mist">
              Assign an outcome in your own words. Context and memory carry into future work.
            </p>
            <div className="mt-5 grid gap-2 text-left">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  className="rounded-xl border border-line bg-panel/60 px-4 py-3 text-sm text-snow transition-colors hover:bg-panel"
                  onClick={() => setPrompt(starter)}
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {items.length > 0 ? (
          <div className="mx-auto max-w-3xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-mist">Recent work</h3>
              <span className="text-xs text-mist">{items.length} thread{items.length === 1 ? "" : "s"}</span>
            </div>
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-panel"
                    onClick={() => onOpen(item.id)}
                  >
                    <StatusDot tone={attentionBySession[item.id] ? "amber" : threadTone(item.status)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-snow">{item.title}</span>
                    <span
                      className={`shrink-0 text-xs ${attentionBySession[item.id] ? "font-medium text-amber" : "text-mist"}`}
                      title={attentionBySession[item.id] || undefined}
                    >
                      {attentionBySession[item.id]
                        ? "Needs you"
                        : item.status === "busy"
                          ? "Working"
                          : item.status === "retry"
                            ? "Retrying"
                            : relativeTime(item.updatedAt)}
                    </span>
                    <span className="text-mist" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <Composer
        value={prompt}
        onChange={setPrompt}
        onSubmit={() => void assign()}
        busy={busy}
        error={assignError}
        placeholder={`Assign work to ${coworker.name}…`}
        submitLabel="Assign"
      />
    </section>
  );
}

function ThreadView({
  threads,
  threadId,
  coworker,
  runtime,
  onBack,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  coworker: CoworkerSummary;
  runtime: RuntimeInfo;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [title, setTitle] = useState("Work thread");
  const [statusLabel, setStatusLabel] = useState("idle");
  const [terminalError, setTerminalError] = useState("");
  const [pending, setPending] = useState<PendingInteractions>({ permissions: [], questions: [] });
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const mcpClient = useMemo(
    () => createCoworkerMcpClient({
      serverUrl: runtime.serverUrl,
      workspaceId: coworker.workspaceId,
      token: runtime.ownerToken,
    }),
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );

  const refresh = useCallback(async () => {
    try {
      const [transcript, interactions] = await Promise.all([
        threads.client.exportTranscript(threadId),
        threads.listThreadInteractions(threadId).catch((): PendingInteractions => ({ permissions: [], questions: [] })),
      ]);
      setPending(interactions);
      setTitle(transcript.title ?? "Work thread");
      setStatusLabel(transcript.status.type);
      setTerminalError(
        transcript.terminalError
          ? `${transcript.terminalError.name}: ${transcript.terminalError.message}`
          : "",
      );
      setMessages(
        transcript.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          toolCalls: message.toolCalls.map((call) => ({
            partId: call.partId,
            tool: call.name,
            status: call.status ?? "working",
            input: call.input,
            output: call.output,
            error: call.error,
            metadata: call.metadata,
          })),
        })),
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threads, threadId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = threads.subscribe(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [threads, refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, statusLabel, pending.permissions.length, pending.questions.length]);

  async function send() {
    const text = reply.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      await threads.client.sendTurn(threadId, { prompt: text });
      setReply("");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const needsYou = hasPendingInteractions(pending);
  const working = statusLabel !== "idle" && !needsYou;
  const readableStatus = needsYou ? "Needs you" : statusLabel === "retry" ? "Retrying" : working ? "Working" : "Ready";

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Button variant="ghost" className="px-2" onClick={onBack} title="Back to recent work">
          ←
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-snow">{title}</h2>
          <p className={`text-xs ${needsYou ? "text-amber" : working ? "text-spark" : "text-mist"}`}>{readableStatus}</p>
        </div>
        {working || needsYou ? (
          <Button variant="ghost" onClick={() => void threads.client.abortThread(threadId)}>
            Stop
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} coworker={coworker} mcpClient={mcpClient} />
          ))}
          <InteractionCards
            coworker={coworker}
            pending={pending}
            onPermission={async (permission, decision) => {
              await threads.replyPermission(permission, decision);
              void refresh();
            }}
            onAnswer={async (question, answers) => {
              await threads.replyQuestion(question, answers);
              void refresh();
            }}
            onSkip={async (question) => {
              await threads.rejectQuestion(question);
              void refresh();
            }}
          />
          {working ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-mist">
              <span className="size-2 animate-pulse rounded-full bg-spark" />
              {coworker.name} is working…
            </div>
          ) : null}
          {messages.length === 0 && !error ? <Empty><InlineLoader label="Loading activity" /></Empty> : null}
          {terminalError ? (
            <ErrorNote>
              The last turn failed — {terminalError}. Choose another model in coworker details or try again.
            </ErrorNote>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div ref={endRef} />
        </div>
      </div>
      <Composer
        value={reply}
        onChange={setReply}
        onSubmit={() => void send()}
        busy={busy}
        placeholder={`Message ${coworker.name}…`}
        submitLabel="Send"
        compact
      />
    </section>
  );
}

function MessageBubble({
  message,
  coworker,
  mcpClient,
}: {
  message: TranscriptMessage;
  coworker: CoworkerSummary;
  mcpClient: CoworkerMcpClient;
}) {
  const user = message.role === "user";
  return (
    <article className={`flex items-end gap-2 ${user ? "justify-end" : "justify-start"}`}>
      {!user ? (
        <CoworkerAvatar
          animated={false}
          color={coworker.avatarColor}
          glasses={coworker.avatarGlasses}
          name={coworker.name}
          size={30}
        />
      ) : null}
      <div
        className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
          user ? "rounded-br-md bg-snow text-ink" : "rounded-bl-md bg-panel text-snow"
        }`}
      >
        {!user ? <p className="mb-1 text-[11px] font-semibold text-mist">{coworker.name}</p> : null}
        {message.text || (message.toolCalls.length > 0 ? "" : "…")}
        {message.toolCalls.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {message.toolCalls.map((call) => <ToolReceipt key={call.partId} call={call} client={mcpClient} />)}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

function toolPresentation(call: TranscriptToolCall): { label: string; source: string } {
  const normalized = call.tool.toLowerCase();
  const source = call.tool.includes("_") ? call.tool.split("_")[0] || "OpenWork" : "OpenWork";
  if (normalized.endsWith("search_capabilities")) {
    const query = typeof call.input.query === "string" ? call.input.query.trim() : "";
    return { label: query ? `Searched for “${query}”` : "Searched connected capabilities", source: "OpenWork Connect" };
  }
  if (normalized.endsWith("execute_capability")) {
    const selected = typeof call.input.name === "string" ? call.input.name.trim() : "";
    return { label: selected ? `Used ${selected}` : "Ran a connected capability", source: "OpenWork Connect" };
  }
  return {
    label: call.tool.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()),
    source,
  };
}

function ToolReceipt({ call, client }: { call: TranscriptToolCall; client: CoworkerMcpClient }) {
  const nextResult = preservedMcpAppResult({ output: call.output, metadata: call.metadata });
  const resultSignature = JSON.stringify(nextResult);
  const resultRef = useRef<{ signature: string; value: PreservedMcpAppResult | null }>({
    signature: resultSignature,
    value: nextResult,
  });
  if (resultRef.current.signature !== resultSignature) {
    resultRef.current = { signature: resultSignature, value: nextResult };
  }
  const result = resultRef.current.value;
  const launch = useMemo(() => gatewayMcpAppLaunch(result?._meta), [result]);
  const inputSignature = JSON.stringify(launch?.arguments ?? call.input);
  const inputRef = useRef<{ signature: string; value: Record<string, unknown> }>({
    signature: inputSignature,
    value: launch?.arguments ?? call.input,
  });
  if (inputRef.current.signature !== inputSignature) {
    inputRef.current = { signature: inputSignature, value: launch?.arguments ?? call.input };
  }
  const [app, setApp] = useState<CoworkerMcpAppResource | null>(null);
  const [appError, setAppError] = useState("");
  const presentation = toolPresentation(call);
  const artifacts = artifactsForToolCall(call);
  const failed = call.status === "error" || call.status === "failed";
  const complete = call.status === "completed" || call.status === "success";

  useEffect(() => {
    let cancelled = false;
    setApp(null);
    setAppError("");
    if (!result || !complete) return;
    void client.resolveApp(call.tool, launch ?? undefined)
      .then(({ app: resolved }) => {
        if (!cancelled) setApp(resolved);
      })
      .catch((cause) => {
        if (!cancelled) setAppError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [call.tool, client, complete, launch, result]);

  return (
    <li className="rounded-xl border border-line bg-ink/70 px-2.5 py-2 text-xs text-snow">
      <div className="flex items-center gap-2">
        <StatusDot tone={failed ? "rose" : complete ? "mint" : "spark"} />
        <span className="min-w-0 flex-1 truncate">{presentation.label}</span>
        <span className="shrink-0 text-[10px] text-mist">{failed ? "Failed" : complete ? "Done" : "Working"}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 pl-4 text-[9px] text-mist/75">
        <span className="truncate">{presentation.source}</span>
        <details className="shrink-0">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 max-w-64 break-all text-right font-mono">{call.tool}</p>
        </details>
      </div>
      {call.error ? <p className="mt-2 pl-4 text-[10px] text-rose">{call.error}</p> : null}
      {complete && artifacts.length > 0 ? (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2" data-testid="coworker-artifacts">
          {artifacts.map((artifact) => (
            <div key={`${artifact.kind}:${artifact.value}`} className="flex items-center gap-2 rounded-lg bg-white/[0.035] px-2.5 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-ink text-mist">
                <ArtifactIcon kind={artifact.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[9px] font-semibold uppercase tracking-[0.1em] text-mist">{artifactKindLabel(artifact.kind)}</span>
                <span className="mt-0.5 block truncate text-[11px] font-medium text-snow" title={artifact.value}>{artifact.label}</span>
              </span>
              {artifact.openUrl ? (
                <button
                  type="button"
                  className="rounded-lg border border-white/9 px-2 py-1 text-[10px] font-medium text-mist transition-colors hover:bg-white/6 hover:text-snow"
                  onClick={() => void coworkerBridge.openExternal(artifact.openUrl ?? "")}
                >
                  Open
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {app && result ? (
        <div className="mt-2">
          <McpAppFrame
            client={client}
            app={app}
            toolName={call.tool}
            input={inputRef.current.value}
            result={result}
            onClose={() => setApp(null)}
          />
        </div>
      ) : null}
      {appError ? <p className="mt-2 pl-4 text-[10px] text-mist">Interactive view unavailable. {appError}</p> : null}
    </li>
  );
}

function ArtifactIcon({ kind }: { kind: CoworkerArtifactKind }) {
  if (kind === "browser") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 fill-none stroke-current" strokeWidth="1.4">
        <circle cx="10" cy="10" r="6.7" />
        <path d="M3.6 8h12.8M3.6 12h12.8M10 3.3c1.8 1.8 2.7 4 2.7 6.7s-.9 4.9-2.7 6.7M10 3.3C8.2 5.1 7.3 7.3 7.3 10s.9 4.9 2.7 6.7" />
      </svg>
    );
  }
  if (kind === "image") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 fill-none stroke-current" strokeWidth="1.4">
        <rect x="3" y="3.5" width="14" height="13" rx="2" />
        <circle cx="7.2" cy="7.4" r="1.2" /><path d="m4.5 14 3.8-3.8 2.4 2.4 1.7-1.7 3.1 3.1" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 fill-none stroke-current" strokeWidth="1.4">
      <path d="M5 2.8h6l4 4v10.4H5z" /><path d="M11 2.8v4h4M7.5 10h5M7.5 13h5" />
    </svg>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  error,
  placeholder,
  submitLabel,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error?: string;
  placeholder: string;
  submitLabel: string;
  compact?: boolean;
}) {
  return (
    <div className="border-t border-line bg-ink px-5 pb-2.5 pt-4">
      <div className="mx-auto max-w-3xl">
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 focus-within:border-spark/50">
          {compact ? (
            <input
              className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm text-snow outline-none placeholder:text-mist/70"
              placeholder={placeholder}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) onSubmit();
              }}
            />
          ) : (
            <textarea
              className="min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-snow outline-none placeholder:text-mist/70"
              placeholder={placeholder}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSubmit();
              }}
            />
          )}
          <Button aria-busy={busy} variant="primary" className="rounded-xl" disabled={busy || !value.trim()} onClick={onSubmit}>
            {busy ? `${submitLabel}ing…` : submitLabel}
          </Button>
        </div>
        <div className="mt-1.5 flex min-h-3 items-center justify-between gap-3 px-1 text-[9px] text-mist/65">
          <span>{compact ? "" : "⌘ Enter to assign"}</span>
          <span className="shrink-0 font-medium tracking-[0.06em]">Powered by OpenWork</span>
        </div>
      </div>
    </div>
  );
}
