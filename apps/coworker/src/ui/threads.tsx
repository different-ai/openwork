import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import { createCoworkerThreads, type EngineModelOption, type ThreadListItem } from "@/lib/threads";
import { Button, Empty, ErrorNote, Section, inputClass } from "@/ui/kit";

type TranscriptMessage = {
  id: string;
  role: string;
  text: string;
  toolCalls: Array<{ tool: string; title: string }>;
};

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
  const [models, setModels] = useState<EngineModelOption[]>([]);
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

  // Coworker switches remount this panel (keyed by slug), so this only re-runs
  // for client changes (token/model refresh) where the open thread stays valid.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Model inventory only changes with the engine, so one load per workspace
  // client is enough; a failure leaves the selector on "Engine default".
  useEffect(() => {
    if (!threads || !runtime.engineManaged) return;
    let cancelled = false;
    void threads
      .listModels()
      .then((options) => {
        if (!cancelled) setModels(options);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threads, runtime.engineManaged]);

  const modelSelect = (
    <label className="flex items-center gap-2 text-xs text-mist">
      Model
      <select
        className="max-w-56 rounded-md border border-line bg-ink px-2 py-1 text-xs text-snow focus:border-spark/60 focus:outline-none"
        value={coworker.model}
        onChange={(event) => {
          void (async () => {
            try {
              onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: event.target.value }));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          })();
        }}
      >
        <option value="">Engine default</option>
        {coworker.model && !models.some((option) => option.id === coworker.model) ? (
          <option value={coworker.model}>{coworker.model} (unavailable)</option>
        ) : null}
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  if (!threads) {
    return (
      <Section title="Work">
        <div className="space-y-4">
          <Empty>This coworker's workspace is not registered yet.</Empty>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex justify-center">
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
      </Section>
    );
  }

  if (openThreadId) {
    return (
      <ThreadView
        key={openThreadId}
        threads={threads}
        threadId={openThreadId}
        onBack={() => {
          setOpenThreadId("");
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <NewAssignment
        onAssigned={(threadId) => {
          setOpenThreadId(threadId);
        }}
        threads={threads}
        coworkerName={coworker.name}
        actions={modelSelect}
      />
      <Section
        title="Threads"
        actions={
          <Button variant="ghost" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      >
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {items.length === 0 && !error ? <Empty>No work yet. Give {coworker.name} its first assignment above.</Empty> : null}
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id}>
              <button
                className="flex w-full items-center justify-between gap-4 px-1 py-2.5 text-left text-sm text-snow hover:text-spark"
                onClick={() => setOpenThreadId(item.id)}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-xs text-mist">
                  {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function NewAssignment({
  threads,
  coworkerName,
  actions,
  onAssigned,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  coworkerName: string;
  actions?: ReactNode;
  onAssigned: (threadId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function assign() {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const title = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      const thread = await threads.client.createThread({ title, prompt: text });
      setPrompt("");
      onAssigned(thread.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={`Give ${coworkerName} work`} actions={actions}>
      <div className="space-y-3">
        <textarea
          className={`${inputClass} min-h-20 resize-y`}
          placeholder="Describe the assignment. The coworker keeps its own memory, so context carries over."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex justify-end">
          <Button variant="primary" disabled={busy || !prompt.trim()} onClick={() => void assign()}>
            {busy ? "Assigning…" : "Assign"}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function ThreadView({
  threads,
  threadId,
  onBack,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [title, setTitle] = useState("Thread");
  const [statusLabel, setStatusLabel] = useState("idle");
  const [terminalError, setTerminalError] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const transcript = await threads.client.exportTranscript(threadId);
      setTitle(transcript.title ?? "Thread");
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
            title: call.status ? `${call.name} (${call.status})` : call.name,
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
    pollRef.current = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(pollRef.current);
  }, [refresh]);

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

  return (
    <Section
      title={title}
      actions={
        <>
          <span className={`text-xs ${working ? "text-amber" : "text-mist"}`}>{working ? "working…" : statusLabel}</span>
          {working ? (
            <Button variant="ghost" onClick={() => void threads.client.abortThread(threadId)}>
              Stop
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        </>
      }
    >
      <div className="max-h-[52vh] space-y-3 overflow-y-auto pb-2">
        {messages.map((message) => (
          <article
            key={message.id}
            className={`rounded-lg border px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
              message.role === "user" ? "border-spark/25 bg-spark/10 text-snow" : "border-line bg-panel-2 text-snow"
            }`}
          >
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-mist">
              {message.role === "user" ? "You" : "Coworker"}
            </p>
            {message.text || (message.toolCalls.length > 0 ? "" : "…")}
            {message.toolCalls.length > 0 ? (
              <p className="mt-1.5 text-xs text-mist">
                {message.toolCalls.map((call) => call.title).join(" · ")}
              </p>
            ) : null}
          </article>
        ))}
        {messages.length === 0 && !error ? <Empty>Loading thread…</Empty> : null}
      </div>
      {terminalError ? (
        <ErrorNote>
          The coworker's last turn failed — {terminalError}. Pick a different model above or try
          again.
        </ErrorNote>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-3 flex gap-2">
        <input
          className={inputClass}
          placeholder="Follow up…"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) void send();
          }}
        />
        <Button variant="primary" disabled={busy || !reply.trim()} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </Section>
  );
}
