import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import { createCoworkerThreads, type ThreadListItem } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, Empty, ErrorNote, StatusDot } from "@/ui/kit";

type TranscriptMessage = {
  id: string;
  role: string;
  text: string;
  toolCalls: Array<{ tool: string; status: string }>;
};

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
}: {
  runtime: RuntimeInfo;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onRefreshRuntime: () => Promise<void>;
}) {
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
            model: coworker.model,
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model],
  );
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [openThreadId, setOpenThreadId] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!threads) return;
    try {
      setItems(await threads.listThreads());
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
      onOpen={setOpenThreadId}
      threads={threads}
    />
  );
}

function WorkOverview({
  threads,
  coworker,
  items,
  error,
  onOpen,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  coworker: CoworkerSummary;
  items: ThreadListItem[];
  error: string;
  onOpen: (threadId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignError, setAssignError] = useState("");

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
                    <StatusDot tone={threadTone(item.status)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-snow">{item.title}</span>
                    <span className="shrink-0 text-xs text-mist">
                      {item.status === "busy" ? "Working" : item.status === "retry" ? "Retrying" : relativeTime(item.updatedAt)}
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
  onBack,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  coworker: CoworkerSummary;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [title, setTitle] = useState("Work thread");
  const [statusLabel, setStatusLabel] = useState("idle");
  const [terminalError, setTerminalError] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const transcript = await threads.client.exportTranscript(threadId);
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
            tool: call.name,
            status: call.status ?? "working",
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
  }, [messages.length, statusLabel]);

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

  const working = statusLabel !== "idle";
  const readableStatus = statusLabel === "retry" ? "Retrying" : working ? "Working" : "Ready";

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Button variant="ghost" className="px-2" onClick={onBack} title="Back to recent work">
          ←
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-snow">{title}</h2>
          <p className={`text-xs ${working ? "text-spark" : "text-mist"}`}>{readableStatus}</p>
        </div>
        {working ? (
          <Button variant="ghost" onClick={() => void threads.client.abortThread(threadId)}>
            Stop
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} coworker={coworker} />
          ))}
          {working ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-mist">
              <span className="size-2 animate-pulse rounded-full bg-spark" />
              {coworker.name} is working…
            </div>
          ) : null}
          {messages.length === 0 && !error ? <Empty>Loading activity…</Empty> : null}
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

function MessageBubble({ message, coworker }: { message: TranscriptMessage; coworker: CoworkerSummary }) {
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
            {message.toolCalls.map((call, index) => {
              const failed = call.status === "error" || call.status === "failed";
              const complete = call.status === "completed" || call.status === "success";
              return (
                <li key={`${call.tool}-${index}`} className="flex items-center gap-2 rounded-lg border border-line bg-ink/70 px-2.5 py-2 text-xs text-snow">
                  <StatusDot tone={failed ? "rose" : complete ? "mint" : "spark"} />
                  <span className="min-w-0 flex-1 truncate">{call.tool}</span>
                  <span className="text-mist">{failed ? "Failed" : complete ? "Done" : "Activity"}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </article>
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
    <div className="border-t border-line bg-ink px-5 py-4">
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
          <Button variant="primary" className="rounded-xl" disabled={busy || !value.trim()} onClick={onSubmit}>
            {busy ? `${submitLabel}ing…` : submitLabel}
          </Button>
        </div>
        {!compact ? <p className="mt-1.5 px-1 text-[10px] text-mist">⌘ Enter to assign</p> : null}
      </div>
    </div>
  );
}
