import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  PauseCircle,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";

import type { MessageWithParts, PendingQuestion, TodoItem } from "../../app/types";
import { deriveArtifacts, deriveWorkingFiles, formatRelativeTime, isVisibleTextPart } from "../../app/utils";
import {
  selectActiveWorkspace,
  selectSelectedHasEarlierMessages,
  selectSelectedLoadingEarlierMessages,
  selectSelectedSession,
  useOpenworkStore,
} from "../kernel/store";
import { PartRenderer } from "./part-renderer";
import { QuestionSheet } from "./question-sheet";

const EMPTY_MESSAGES: MessageWithParts[] = [];
const EMPTY_TODOS: TodoItem[] = [];

function roleLabel(role: string) {
  return role === "user" ? "You" : "OpenWork";
}

function messagePreview(message: MessageWithParts) {
  return message.parts
    .filter(isVisibleTextPart)
    .map((part) => String((part as { text?: string }).text ?? ""))
    .join(" ")
    .trim();
}

function deriveSessionHeading(sessionId: string | null, messages: MessageWithParts[], explicitTitle?: string | null) {
  if (explicitTitle?.trim()) return explicitTitle.trim();
  if (!sessionId) return "Fresh task";
  const firstUser = messages.find((message) => message.info.role === "user");
  const preview = firstUser ? messagePreview(firstUser) : "";
  return preview ? preview.slice(0, 84) : `Task ${sessionId.slice(0, 8)}`;
}

function matchesSearch(message: MessageWithParts, query: string) {
  if (!query.trim()) return true;
  const haystack = [roleLabel(message.info.role), messagePreview(message), ...message.parts.map((part) => JSON.stringify(part))]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

function permissionLabel(permission: Record<string, unknown>) {
  if (typeof permission.message === "string" && permission.message.trim()) return permission.message;
  if (typeof permission.tool === "string" && permission.tool.trim()) return permission.tool;
  return String(permission.id ?? "Permission request");
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
  const pendingQuestions = useOpenworkStore((state) => state.pendingQuestions);
  const hasEarlierMessages = useOpenworkStore(selectSelectedHasEarlierMessages);
  const loadingEarlierMessages = useOpenworkStore(selectSelectedLoadingEarlierMessages);
  const errorBanner = useOpenworkStore((state) => state.errorBanner);
  const sending = useOpenworkStore((state) => state.sending);
  const clearErrorBanner = useOpenworkStore((state) => state.clearErrorBanner);
  const createSession = useOpenworkStore((state) => state.createSession);
  const sendPrompt = useOpenworkStore((state) => state.sendPrompt);
  const selectSession = useOpenworkStore((state) => state.selectSession);
  const deleteSession = useOpenworkStore((state) => state.deleteSession);
  const replyPermission = useOpenworkStore((state) => state.replyPermission);
  const replyQuestion = useOpenworkStore((state) => state.replyQuestion);
  const rejectQuestion = useOpenworkStore((state) => state.rejectQuestion);
  const abortSession = useOpenworkStore((state) => state.abortSession);
  const renameSession = useOpenworkStore((state) => state.renameSession);
  const loadEarlierMessages = useOpenworkStore((state) => state.loadEarlierMessages);
  const setCreateWorkspaceOpen = useOpenworkStore((state) => state.setCreateWorkspaceOpen);

  const [draft, setDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [questionBusy, setQuestionBusy] = useState(false);
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
  const scopedQuestions = useMemo(
    () => (selectedSessionId ? pendingQuestions.filter((item) => item.sessionID === selectedSessionId) : pendingQuestions),
    [pendingQuestions, selectedSessionId],
  );
  const activeQuestion = scopedQuestions[0] ?? null;

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
    setTitleDraft(deriveSessionHeading(selectedSession?.id ?? sessionId ?? null, messages, selectedSession?.title ?? null));
  }, [messages, selectedSession?.id, selectedSession?.title, sessionId]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, status]);

  const headerTitle = deriveSessionHeading(selectedSession?.id ?? sessionId ?? null, messages, selectedSession?.title ?? null);
  const filteredMessages = useMemo(() => messages.filter((message) => matchesSearch(message, searchQuery)), [messages, searchQuery]);
  const artifacts = useMemo(() => deriveArtifacts(messages, { maxMessages: 200 }), [messages]);
  const workingFiles = useMemo(() => deriveWorkingFiles(artifacts), [artifacts]);
  const canSend = Boolean(activeWorkspace) && draft.trim().length > 0 && !sending;
  const statusTone = status === "running" ? "Streaming" : status === "retry" ? "Retrying" : "Idle";
  const canRename = Boolean(selectedSession?.id && titleDraft.trim().length > 0 && titleDraft.trim() !== (selectedSession.title?.trim() || headerTitle));
  const lastMessageId = filteredMessages[filteredMessages.length - 1]?.info.id;

  const emptyState = useMemo(() => {
    if (!activeWorkspace) {
      return {
        title: "Create or connect a workspace",
        body: "Start with a native workspace on this device, or connect to an existing remote worker and open a session from there.",
        actionLabel: "Add workspace",
        href: null,
      };
    }
    if (!selectedSession) {
      return {
        title: "Start a real task",
        body: "Create a session to unlock transcript search, working files, todo tracking, streamed markdown, and question/permission handling in the new shell.",
        actionLabel: "Create task",
        href: null,
      };
    }
    return null;
  }, [activeWorkspace, selectedSession]);

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

  const handleRename = async () => {
    if (!selectedSession?.id || !canRename) return;
    await renameSession(selectedSession.id, titleDraft.trim());
  };

  const handleReplyQuestion = async (answers: string[][]) => {
    if (!activeQuestion) return;
    setQuestionBusy(true);
    try {
      await replyQuestion(activeQuestion.id, answers);
    } finally {
      setQuestionBusy(false);
    }
  };

  const handleRejectQuestion = async () => {
    if (!activeQuestion) return;
    setQuestionBusy(true);
    try {
      await rejectQuestion(activeQuestion.id);
    } finally {
      setQuestionBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="ow-soft-shell px-5 py-5 lg:px-6 lg:py-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="ow-kicker">
              <Sparkles className="h-3.5 w-3.5" />
              Session
            </div>
            <div className="space-y-3">
              <input
                className="ow-title-input"
                id="openwork-session-title"
                name="openworkSessionTitle"
                onChange={(event) => setTitleDraft(event.target.value)}
                placeholder="Name this task"
                value={titleDraft}
              />
              <p className="max-w-3xl text-sm leading-7 text-slate-600">
                Review the transcript, keep context visible, and continue work in the current workspace.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className={status === "running" ? "ow-status-pill ow-status-pill-warning" : "ow-status-pill ow-status-pill-neutral"}>{statusTone}</span>
              {selectedSession?.time?.updated ? <span>Updated {formatRelativeTime(selectedSession.time.updated)}</span> : null}
              {activeWorkspace ? <span>Scope: {activeWorkspace.displayName || activeWorkspace.name}</span> : null}
              {messages.length ? <span>{messages.length} transcript entries</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 lg:justify-end">
            <button className="ow-button-primary" onClick={() => void handleCreateSession()} type="button">
              <Plus className="h-4 w-4" />
              New task
            </button>
            <button className="ow-button-secondary" disabled={!canRename} onClick={() => void handleRename()} type="button">
              <Save className="h-4 w-4" />
              Save title
            </button>
            {status === "running" || status === "retry" ? (
              <button className="ow-button-secondary" onClick={() => void abortSession(selectedSession?.id)} type="button">
                <PauseCircle className="h-4 w-4" />
                Stop
              </button>
            ) : null}
            {selectedSession ? (
              <button className="ow-button-secondary" onClick={() => void deleteSession(selectedSession.id)} type="button">
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {errorBanner ? (
        <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-4 w-4 flex-none" />
              <span>{errorBanner}</span>
            </div>
            <button className="text-rose-500 transition hover:text-rose-700" onClick={clearErrorBanner} type="button">
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {permissions.length ? (
        <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <ShieldAlert className="h-4 w-4" />
            Pending permissions
          </div>
          <div className="space-y-3">
            {permissions.map((permission) => (
              <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-white px-4 py-4 lg:flex-row lg:items-center lg:justify-between" key={permission.id}>
                <div>
                  <div className="font-medium text-slate-900">{permissionLabel(permission as Record<string, unknown>)}</div>
                  <div className="mt-1 text-sm leading-6 text-slate-600">{permission.tool ? `Tool: ${permission.tool}` : permission.id}</div>
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
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="ow-soft-shell overflow-hidden">
          {emptyState ? (
            <div className="flex min-h-[32rem] flex-col items-center justify-center gap-5 px-8 py-12 text-center">
              <div className="ow-icon-tile h-14 w-14 rounded-full text-slate-700">
                <Bot className="h-7 w-7" />
              </div>
              <div className="space-y-3">
                <h2 className="text-2xl font-semibold text-slate-900">{emptyState.title}</h2>
                <p className="max-w-xl text-sm leading-7 text-slate-600">{emptyState.body}</p>
              </div>
              {emptyState.href ? (
                <Link className="ow-button-primary" to={emptyState.href}>
                  {emptyState.actionLabel}
                </Link>
              ) : (
                <button
                  className="ow-button-primary"
                  onClick={() => {
                    if (!activeWorkspace) {
                      setCreateWorkspaceOpen(true);
                      return;
                    }
                    void handleCreateSession();
                  }}
                  type="button"
                >
                  {emptyState.actionLabel}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-6">
                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <button className="ow-button-secondary" disabled={!hasEarlierMessages || loadingEarlierMessages} onClick={() => selectedSession?.id && void loadEarlierMessages(selectedSession.id)} type="button">
                    {loadingEarlierMessages ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                    Load earlier
                  </button>
                  {selectedSession?.id ? <span>Session {selectedSession.id.slice(0, 8)}</span> : null}
                </div>
                <label className="relative block min-w-[16rem] lg:w-[20rem]" htmlFor="openwork-session-search">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    className="ow-input pl-10"
                    id="openwork-session-search"
                    name="openworkSessionSearch"
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search transcript"
                    value={searchQuery}
                  />
                </label>
              </div>

              <div ref={threadRef} className="ow-scroller flex max-h-[64vh] flex-col gap-4 px-4 py-5 lg:px-6">
                {filteredMessages.length ? (
                  filteredMessages.map((message) => {
                    const isUser = message.info.role === "user";
                    const isLastAssistant = !isUser && message.info.id === lastMessageId;
                    const isStreaming = isLastAssistant && status !== "idle";
                    return (
                      <article className={isUser ? "ow-message ow-message-user" : "ow-message ow-message-assistant"} key={message.info.id}>
                        <header className="mb-3 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                          <span>{roleLabel(message.info.role)}</span>
                          <span>{message.info.time?.created ? formatRelativeTime(message.info.time.created) : isStreaming ? "streaming" : "ready"}</span>
                        </header>
                        <div className="space-y-3">
                          {message.parts.length ? (
                            message.parts.map((part) => (
                              <PartRenderer isStreaming={isStreaming} key={part.id} part={part} tone={isUser ? "user" : "assistant"} />
                            ))
                          ) : isStreaming ? (
                            <div className="flex items-center gap-2 text-sm text-slate-500">
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                              Waiting for the first streamed token...
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm leading-7 text-slate-500">
                    {searchQuery.trim() ? "No transcript messages match the current search." : "The transcript will appear here once the session starts responding."}
                  </div>
                )}
              </div>

              <form className="border-t border-slate-100 bg-slate-50/60 px-4 py-4 lg:px-6" onSubmit={handleSubmit}>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="openwork-chat-prompt">
                  Prompt
                </label>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                  <textarea
                    className="ow-input min-h-[8rem] resize-y px-4 py-3 leading-7"
                    id="openwork-chat-prompt"
                    name="openworkChatPrompt"
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={activeWorkspace ? "Ask OpenWork to inspect the workspace, edit code, or explain a change..." : "Connect a worker first."}
                    value={draft}
                  />
                  <button className="ow-button-primary justify-center lg:min-w-[11rem]" disabled={!canSend} type="submit">
                    {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <aside className="space-y-4">
          <div className="ow-soft-card px-4 py-4">
            <div className="ow-kicker">Live signal</div>
            <div className="mt-4 grid gap-3 text-sm text-slate-600">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Session status</div>
                <div className="mt-2 font-medium text-slate-900">{statusTone}</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Visible transcript</div>
                <div className="mt-2 font-medium text-slate-900">{filteredMessages.length} items</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Questions</div>
                <div className="mt-2 font-medium text-slate-900">{scopedQuestions.length || 0}</div>
              </div>
            </div>
          </div>

          <div className="ow-soft-card px-4 py-4">
            <div className="ow-kicker">Working files</div>
            {workingFiles.length ? (
              <div className="mt-4 space-y-2">
                {workingFiles.map((file) => (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700" key={file}>
                    {file}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm leading-7 text-slate-500">Files mentioned by tool output will collect here as the task evolves.</p>
            )}
          </div>

          <div className="ow-soft-card px-4 py-4">
            <div className="ow-kicker">Artifacts</div>
            {artifacts.length ? (
              <div className="mt-4 space-y-2">
                {artifacts.slice(0, 8).map((artifact) => (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3" key={artifact.id}>
                    <div className="font-medium text-slate-900">{artifact.name}</div>
                    {artifact.path ? <div className="mt-1 text-sm leading-6 text-slate-500">{artifact.path}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm leading-7 text-slate-500">Generated files and surfaced outputs will show up here once the session performs file work.</p>
            )}
          </div>

          <div className="ow-soft-card px-4 py-4">
            <div className="ow-kicker">Todo stream</div>
            {todos.length ? (
              <div className="mt-4 space-y-3">
                {todos.map((todo) => (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3" key={todo.id}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">{todo.content}</span>
                      <span className="ow-status-pill ow-status-pill-neutral">{todo.status}</span>
                    </div>
                    <div className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Priority {todo.priority}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm leading-7 text-slate-500">The session has not emitted structured todo items yet.</p>
            )}
          </div>
        </aside>
      </div>

      <QuestionSheet busy={questionBusy} onReject={handleRejectQuestion} onReply={handleReplyQuestion} question={activeQuestion as PendingQuestion | null} />
    </section>
  );
}
