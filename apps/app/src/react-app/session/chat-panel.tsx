import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Bot, ChevronRight, CircleAlert, LoaderCircle, Plus, Send, ShieldAlert, Sparkles, Trash2 } from "lucide-react";

import type { MessageWithParts, TodoItem } from "../../app/types";
import { formatRelativeTime, isVisibleTextPart } from "../../app/utils";
import {
  selectActiveWorkspace,
  selectSelectedSession,
  useOpenworkStore,
} from "../kernel/store";
import { PartRenderer } from "./part-renderer";

const EMPTY_MESSAGES: MessageWithParts[] = [];
const EMPTY_TODOS: TodoItem[] = [];

function roleLabel(role: string) {
  return role === "user" ? "You" : "OpenWork";
}

function sessionTitle(sessionId: string | null, messages: typeof EMPTY_MESSAGES) {
  if (!sessionId) return "Fresh task";
  const firstUser = messages.find((message) => message.info.role === "user");
  const preview = firstUser?.parts.filter(isVisibleTextPart).map((part) => String((part as { text?: string }).text ?? "")).join(" ") ?? "";
  return preview.trim() ? preview.trim().slice(0, 72) : `Task ${sessionId.slice(0, 8)}`;
}

export function ChatPanel() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const activeWorkspace = useOpenworkStore(selectActiveWorkspace);
  const selectedSession = useOpenworkStore(selectSelectedSession);
  const selectedSessionId = useOpenworkStore((state) => state.selectedSessionId);
  const messagesBySessionId = useOpenworkStore((state) => state.messagesBySessionId);
  const todosBySessionId = useOpenworkStore((state) => state.todosBySessionId);
  const sessionStatusById = useOpenworkStore((state) => state.sessionStatusById);
  const pendingPermissions = useOpenworkStore((state) => state.pendingPermissions);
  const errorBanner = useOpenworkStore((state) => state.errorBanner);
  const sending = useOpenworkStore((state) => state.sending);
  const clearErrorBanner = useOpenworkStore((state) => state.clearErrorBanner);
  const createSession = useOpenworkStore((state) => state.createSession);
  const sendPrompt = useOpenworkStore((state) => state.sendPrompt);
  const selectSession = useOpenworkStore((state) => state.selectSession);
  const deleteSession = useOpenworkStore((state) => state.deleteSession);
  const replyPermission = useOpenworkStore((state) => state.replyPermission);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  const messages = useMemo(
    () => (selectedSessionId ? messagesBySessionId[selectedSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
    [messagesBySessionId, selectedSessionId],
  );
  const todos = useMemo(
    () => (selectedSessionId ? todosBySessionId[selectedSessionId] ?? EMPTY_TODOS : EMPTY_TODOS),
    [selectedSessionId, todosBySessionId],
  );
  const status = selectedSessionId ? sessionStatusById[selectedSessionId] ?? "idle" : "idle";
  const permissions = useMemo(
    () => (selectedSessionId ? pendingPermissions.filter((item) => item.sessionID === selectedSessionId) : pendingPermissions),
    [pendingPermissions, selectedSessionId],
  );

  const permissionLabel = (permission: Record<string, unknown>) => {
    if (typeof permission.message === "string" && permission.message.trim()) return permission.message;
    if (typeof permission.tool === "string" && permission.tool.trim()) return permission.tool;
    return String(permission.id ?? "Permission request");
  };

  useEffect(() => {
    if (sessionId && sessionId !== selectedSession?.id) {
      void selectSession(sessionId);
      return;
    }
    if (!sessionId && selectedSession?.id) {
      navigate(`/session/${selectedSession.id}`, { replace: true });
    }
  }, [navigate, selectSession, selectedSession?.id, sessionId]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, status]);

  const canSend = Boolean(activeWorkspace) && draft.trim().length > 0 && !sending;
  const headerTitle = sessionTitle(selectedSession?.id ?? sessionId ?? null, messages);

  const handleCreateSession = async () => {
    const next = await createSession();
    if (next) {
      navigate(`/session/${next}`);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    const nextPrompt = draft;
    setDraft("");
    await sendPrompt(nextPrompt);
  };

  const lastMessageId = messages[messages.length - 1]?.info.id;
  const statusTone = status === "running" ? "Streaming" : status === "retry" ? "Retrying" : "Idle";

  const emptyState = useMemo(() => {
    if (!activeWorkspace) {
      return {
        title: "Connect a worker to start",
        body: "Set the OpenWork server URL and token, then choose a workspace. Once the workspace is active, this session surface will stream replies with Streamdown.",
        actionLabel: "Open connection settings",
        href: "/settings",
      };
    }
    if (!selectedSession) {
      return {
        title: "Spin up a fresh task",
        body: "Create a session for the active workspace, then send a prompt. The React rewrite keeps the flow focused on the live transcript, workspace scope, and remote status.",
        actionLabel: "Create new task",
        href: null,
      };
    }
    return null;
  }, [activeWorkspace, selectedSession]);

  return (
    <section className="flex min-h-[70vh] flex-col gap-4">
      <div className="ow-card flex flex-col gap-4 px-5 py-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-amber-200/70">
              <Sparkles className="h-3.5 w-3.5" />
              Session surface
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-slate-50">{headerTitle}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300/80">
                Workspace-scoped sessions, streamed markdown, and live remote state now run through a React + Zustand shell.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="ow-button-secondary" onClick={() => void handleCreateSession()} type="button">
              <Plus className="h-4 w-4" />
              New task
            </button>
            {selectedSession ? (
              <button className="ow-button-secondary" onClick={() => void deleteSession(selectedSession.id)} type="button">
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300/75">
          <span className="ow-pill">{statusTone}</span>
          {selectedSession?.time?.updated ? <span>Updated {formatRelativeTime(selectedSession.time.updated)}</span> : null}
          {activeWorkspace ? <span>Scope: {activeWorkspace.displayName || activeWorkspace.name}</span> : null}
          {todos.length ? <span>{todos.length} tracked todo{todos.length === 1 ? "" : "s"}</span> : null}
        </div>
      </div>

      {errorBanner ? (
        <div className="ow-card flex items-start justify-between gap-4 border-rose-400/35 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 h-4 w-4 flex-none" />
            <span>{errorBanner}</span>
          </div>
          <button className="text-rose-200/80 transition hover:text-white" onClick={clearErrorBanner} type="button">
            Dismiss
          </button>
        </div>
      ) : null}

      {permissions.length ? (
        <div className="ow-card space-y-3 border-amber-300/30 bg-amber-300/8 px-4 py-4 text-sm text-amber-50">
          {permissions.map((permission) => (
            <div key={permission.id} className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" />
                <div>
                  <div className="font-medium">Permission requested</div>
                  <div className="mt-1 text-amber-50/80">{permissionLabel(permission as Record<string, unknown>)}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="ow-button-secondary" onClick={() => void replyPermission(permission.id, "once")} type="button">
                  Allow once
                </button>
                <button className="ow-button-secondary" onClick={() => void replyPermission(permission.id, "always")} type="button">
                  Always allow
                </button>
                <button className="ow-button-secondary" onClick={() => void replyPermission(permission.id, "reject")} type="button">
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="ow-card overflow-hidden">
          {emptyState ? (
            <div className="flex min-h-[28rem] flex-col items-center justify-center gap-5 px-8 py-12 text-center">
              <div className="rounded-full border border-white/10 bg-white/6 p-4 text-amber-100">
                <Bot className="h-7 w-7" />
              </div>
              <div className="space-y-3">
                <h2 className="text-2xl font-semibold text-slate-50">{emptyState.title}</h2>
                <p className="max-w-xl text-sm leading-7 text-slate-300/78">{emptyState.body}</p>
              </div>
              {emptyState.href ? (
                <Link className="ow-button" to={emptyState.href}>
                  {emptyState.actionLabel}
                </Link>
              ) : (
                <button className="ow-button" onClick={() => void handleCreateSession()} type="button">
                  {emptyState.actionLabel}
                </button>
              )}
            </div>
          ) : (
            <>
              <div ref={threadRef} className="ow-scroller flex max-h-[60vh] flex-col gap-4 px-4 py-5 lg:px-6">
                {messages.map((message) => {
                  const isUser = message.info.role === "user";
                  const isLastAssistant = !isUser && message.info.id === lastMessageId;
                  const isStreaming = isLastAssistant && status !== "idle";

                  return (
                    <article
                      className={[
                        "max-w-4xl rounded-[28px] border px-4 py-4 shadow-[0_24px_64px_rgba(2,8,23,0.18)] lg:px-5",
                        isUser
                          ? "ml-auto border-sky-300/25 bg-sky-300/10 text-sky-50"
                          : "border-white/10 bg-white/6 text-slate-100",
                      ].join(" ")}
                      key={message.info.id}
                    >
                      <header className="mb-3 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.22em] text-slate-300/58">
                        <span>{roleLabel(message.info.role)}</span>
                        <span>
                          {message.info.time?.created ? formatRelativeTime(message.info.time.created) : isStreaming ? "streaming" : "ready"}
                        </span>
                      </header>
                      <div className="space-y-3">
                        {message.parts.length ? (
                          message.parts.map((part) => (
                            <PartRenderer
                              isStreaming={isStreaming}
                              key={part.id}
                              part={part}
                              tone={isUser ? "user" : "assistant"}
                            />
                          ))
                        ) : isStreaming ? (
                          <div className="flex items-center gap-2 text-sm text-slate-200/75">
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                            Waiting for the first streamed token...
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              <form className="border-t border-white/10 bg-black/14 px-4 py-4 lg:px-6" onSubmit={handleSubmit}>
                <label className="mb-3 block text-xs uppercase tracking-[0.22em] text-slate-300/55" htmlFor="openwork-chat-prompt">
                  Prompt
                </label>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                  <textarea
                    className="ow-textarea min-h-[7.5rem]"
                    id="openwork-chat-prompt"
                    name="openworkChatPrompt"
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={activeWorkspace ? "Ask OpenWork to inspect the workspace, edit code, or explain a change..." : "Connect a worker first."}
                    value={draft}
                  />
                  <button className="ow-button justify-center lg:min-w-[11rem]" disabled={!canSend} type="submit">
                    {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <aside className="space-y-4">
          <div className="ow-card px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">Task radar</div>
                <div className="mt-2 text-lg font-semibold text-slate-50">Live signal</div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </div>
            <div className="mt-4 grid gap-3 text-sm text-slate-300/78">
              <div className="rounded-2xl border border-white/10 bg-white/6 px-3 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Session status</div>
                <div className="mt-2 font-medium text-slate-50">{statusTone}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/6 px-3 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Transcript</div>
                <div className="mt-2 font-medium text-slate-50">{messages.length} message{messages.length === 1 ? "" : "s"}</div>
              </div>
            </div>
          </div>

          <div className="ow-card px-4 py-4">
            <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">Todo stream</div>
            {todos.length ? (
              <div className="mt-4 space-y-3">
                {todos.map((todo) => (
                  <div className="rounded-2xl border border-white/10 bg-white/6 px-3 py-3" key={todo.id}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-50">{todo.content}</span>
                      <span className="ow-pill">{todo.status}</span>
                    </div>
                    <div className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">Priority {todo.priority}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm leading-6 text-slate-300/72">
                No structured todos yet. When the agent starts planning, they will land here automatically.
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
