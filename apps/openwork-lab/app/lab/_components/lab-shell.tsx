"use client";

import {
  AlertTriangle,
  ArrowLeftRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderLock,
  Loader2,
  Plus,
  RefreshCcw,
  Send,
  Settings2,
  Sparkles,
  TerminalSquare,
  Wand2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLab } from "../_providers/lab-provider";

type View = "chat" | "file" | "settings";

function formatWhen(value: number | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderPartContent(part: Record<string, unknown>) {
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.summary === "string") {
    return part.summary;
  }
  return JSON.stringify(part, null, 2);
}

function QuestionCard() {
  const { pendingQuestions, replyQuestion, rejectQuestion } = useLab();
  const request = pendingQuestions[0];
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [customValues, setCustomValues] = useState<Record<number, string>>( {} );

  if (!request) return null;

  const handleToggle = (index: number, option: string, multiple: boolean) => {
    setAnswers((current) => {
      const existing = current[index] ?? [];
      if (!multiple) {
        return { ...current, [index]: [option] };
      }
      return {
        ...current,
        [index]: existing.includes(option)
          ? existing.filter((item) => item !== option)
          : [...existing, option],
      };
    });
  };

  const submit = async () => {
    const payload = request.questions.map((question, index) => {
      const chosen = answers[index] ?? [];
      const custom = customValues[index]?.trim();
      return custom ? [...chosen, custom] : chosen;
    });
    await replyQuestion(request.id, payload);
    setAnswers({});
    setCustomValues({});
  };

  return (
    <section className="lab-card space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="lab-eyebrow">Question pending</div>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-[var(--dls-text-primary)]">
            OpenCode is waiting for an answer.
          </h3>
        </div>
        <button className="lab-button-ghost !min-h-0 !px-3 !py-2" onClick={() => void rejectQuestion(request.id)}>
          Reject
        </button>
      </div>

      <div className="space-y-5">
        {request.questions.map((question, index) => {
          const selection = answers[index] ?? [];
          return (
            <div key={`${request.id}-${index}`} className="space-y-3 rounded-[1.25rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-4">
              <div className="text-sm font-semibold text-[var(--dls-text-primary)]">
                {question.header || question.question}
              </div>
              {question.header && question.header !== question.question ? (
                <div className="text-sm text-[var(--dls-text-secondary)]">{question.question}</div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => {
                  const active = selection.includes(option.description);
                  return (
                    <button
                      key={option.description}
                      type="button"
                      className="lab-tab-button"
                      data-active={active}
                      onClick={() => handleToggle(index, option.description, Boolean(question.multiple))}
                    >
                      {option.description}
                    </button>
                  );
                })}
              </div>
              {question.custom ? (
                <input
                  className="lab-input"
                  placeholder="Add a custom answer"
                  value={customValues[index] ?? ""}
                  onChange={(event) =>
                    setCustomValues((current) => ({ ...current, [index]: event.target.value }))
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <button className="lab-button-primary" onClick={() => void submit()}>
        <Check className="h-4 w-4" />
        Submit answers
      </button>
    </section>
  );
}

function PermissionCards() {
  const { pendingPermissions, replyPermission } = useLab();
  if (!pendingPermissions.length) return null;

  return (
    <section className="lab-card space-y-4">
      <div>
        <div className="lab-eyebrow">Permission queue</div>
        <h3 className="mt-2 text-lg font-semibold tracking-tight text-[var(--dls-text-primary)]">
          OpenCode needs approval to continue.
        </h3>
      </div>
      <div className="space-y-3">
        {pendingPermissions.map((request) => (
          <div key={request.id} className="rounded-[1.25rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="space-y-2">
                <div className="text-sm font-semibold text-[var(--dls-text-primary)]">
                  {request.permission || "Permission request"}
                </div>
                {Array.isArray(request.patterns) && request.patterns.length ? (
                  <div className="text-sm text-[var(--dls-text-secondary)]">
                    {request.patterns.join(", ")}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="lab-button-secondary !min-h-0 !px-3 !py-2" onClick={() => void replyPermission(request.id, "once")}>Allow once</button>
                <button className="lab-button-primary !min-h-0 !px-3 !py-2" onClick={() => void replyPermission(request.id, "always")}>Always allow</button>
                <button className="lab-button-danger !min-h-0 !px-3 !py-2" onClick={() => void replyPermission(request.id, "reject")}>Reject</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SessionView() {
  const {
    createSession,
    hasEarlierMessages,
    loadEarlierMessages,
    matchingMessageIds,
    modelOptions,
    pendingPermissions,
    pendingQuestions,
    prompt,
    searchQuery,
    selectedMessages,
    selectedModelKey,
    selectedSession,
    selectedTodos,
    sendPrompt,
    sending,
    setPrompt,
    setSearchQuery,
    setSelectedModelKey,
  } = useLab();

  const visibleMessages = useMemo(() => {
    if (!searchQuery.trim()) return selectedMessages;
    return selectedMessages.filter((message) => matchingMessageIds.has(message.info.id));
  }, [matchingMessageIds, searchQuery, selectedMessages]);

  return (
        <section className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-h-0 flex-col gap-4">
        <div className="lab-card flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="lab-eyebrow">Session</div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">
              {selectedSession?.title?.trim() || "New task"}
            </h2>
            <p className="mt-2 text-sm text-[var(--dls-text-secondary)]">
              Keep the transcript readable. Let everything else support it.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              className="lab-search sm:min-w-[220px]"
              placeholder="Search this session"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <select
              className="lab-select sm:min-w-[260px]"
              value={selectedModelKey}
              onChange={(event) => setSelectedModelKey(event.target.value)}
            >
              <option value="">Use server default model</option>
              {modelOptions.map((option) => (
                <option key={`${option.providerID}/${option.modelID}`} value={`${option.providerID}/${option.modelID}`}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="lab-button-secondary" onClick={() => void createSession()}>
              <Plus className="h-4 w-4" />
              New session
            </button>
          </div>
        </div>

        {pendingPermissions.length ? <PermissionCards /> : null}
        {pendingQuestions.length ? <QuestionCard /> : null}

        <div className="lab-card flex min-h-[26rem] flex-1 flex-col gap-3">
          {hasEarlierMessages ? (
            <div className="flex justify-center">
              <button className="lab-button-secondary" onClick={() => void loadEarlierMessages()}>
                <ChevronDown className="h-4 w-4" />
                Load earlier messages
              </button>
            </div>
          ) : null}

          <div className="lab-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {!selectedSession ? (
              <div className="lab-empty">
                Create a session, send a prompt, and let the workspace stay out of the way.
              </div>
            ) : visibleMessages.length === 0 ? (
              <div className="lab-empty">No matching messages yet.</div>
            ) : (
              visibleMessages.map((message) => {
                const role = message.info.role === "user" ? "user" : "assistant";
                return (
                  <article
                    key={message.info.id}
                    className="lab-message-card space-y-2.5 !p-4"
                    style={{
                      background:
                        role === "user"
                          ? "rgba(238, 244, 255, 0.96)"
                          : "rgba(255, 255, 255, 0.96)",
                    }}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--dls-text-primary)]">
                        {role === "user" ? <Wand2 className="h-4 w-4 text-[var(--lab-blue)]" /> : <Bot className="h-4 w-4 text-[var(--dls-text-secondary)]" />}
                        {role === "user" ? "You" : "OpenWork"}
                      </div>
                      <div className="text-xs text-[var(--dls-text-secondary)]">
                        {formatWhen(message.info.time?.created)}
                      </div>
                    </div>
                    <div className="space-y-2 text-sm leading-7 text-[var(--dls-text-primary)]">
                      {message.parts.map((part, index) => (
                        <div key={`${message.info.id}-${part.id || index}`} className="rounded-[0.95rem] border border-[var(--dls-border)] bg-white/80 px-3.5 py-2.5">
                          <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-sm leading-7 text-[var(--dls-text-primary)]">
                            {renderPartContent(part as Record<string, unknown>)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>

        <div className="lab-card space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="lab-eyebrow">Composer</div>
              <p className="mt-2 text-sm text-[var(--dls-text-secondary)]">
                One clean prompt path into the current session.
              </p>
            </div>
            <button className="lab-button-primary" onClick={() => void sendPrompt()} disabled={sending || !prompt.trim()}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </button>
          </div>
          <textarea
            className="lab-textarea min-h-[8.5rem]"
            placeholder="What do you want OpenWork to do in this workspace?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendPrompt();
              }
            }}
          />
        </div>
      </div>

      <aside className="flex min-h-0 flex-col gap-4">
        <section className="lab-stat-card space-y-3 !p-4">
          <div className="lab-eyebrow">Todo snapshot</div>
          {selectedTodos.length ? (
            <div className="space-y-3">
              {selectedTodos.slice(0, 8).map((todo: any, index) => (
                <div key={`${todo.id ?? index}`} className="rounded-[1rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] px-4 py-3 text-sm text-[var(--dls-text-primary)]">
                  {todo.content || todo.text || JSON.stringify(todo)}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-[var(--dls-text-secondary)]">No todos captured for this session yet.</div>
          )}
        </section>

        <section className="lab-stat-card space-y-3 !p-4">
          <div className="lab-eyebrow">Interaction tips</div>
          <ul className="space-y-3 text-sm leading-7 text-[var(--dls-text-secondary)]">
            <li>• Cmd/Ctrl + Enter sends the composer.</li>
            <li>• Search filters the currently loaded session window.</li>
            <li>• Question and permission cards stay above the transcript so the flow remains readable.</li>
          </ul>
        </section>
      </aside>
    </section>
  );
}

function FileView() {
  const { fileContent, fileError, fileLoading, filePath, fileSaving, fileStatus, loadFile, saveFile, setFileContent, setFilePath } = useLab();
  return (
    <section className="lab-card flex min-h-[42rem] flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="lab-eyebrow">Workspace file</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">Read and edit one file without leaving the lab shell.</h2>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input className="lab-input sm:min-w-[280px]" value={filePath} onChange={(event) => setFilePath(event.target.value)} />
          <button className="lab-button-secondary" onClick={() => void loadFile()} disabled={fileLoading}>
            {fileLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCode2 className="h-4 w-4" />}
            Load
          </button>
          <button className="lab-button-primary" onClick={() => void saveFile()} disabled={fileSaving}>
            {fileSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </button>
        </div>
      </div>

      {fileError ? <div className="lab-error-banner">{fileError}</div> : null}
      {fileStatus ? <div className="text-sm text-[var(--dls-text-secondary)]">{fileStatus}</div> : null}

      <textarea className="lab-textarea min-h-[32rem] flex-1" value={fileContent} onChange={(event) => setFileContent(event.target.value)} />
    </section>
  );
}

function SettingsView() {
  const {
    authorizedFolderDraft,
    authorizedFolders,
    capabilities,
    config,
    configError,
    configLoading,
    connection,
    disconnect,
    reloadBusy,
    reloadEngine,
    reloadStatus,
    removeAuthorizedFolder,
    selectedWorkspace,
    setAuthorizedFolderDraft,
    status,
    workspaceRoot,
    addAuthorizedFolder,
  } = useLab();

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <section className="lab-card space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="lab-eyebrow">Runtime</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">Server-owned controls only.</h2>
              <p className="mt-2 text-sm text-[var(--dls-text-secondary)]">
                Workspace config and engine lifecycle stay behind the OpenWork server path.
              </p>
            </div>
            <button className="lab-button-secondary" onClick={() => void reloadEngine()} disabled={reloadBusy}>
              {reloadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Reload engine
            </button>
          </div>
          {reloadStatus ? <div className="text-sm text-[var(--dls-text-secondary)]">{reloadStatus}</div> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[1.25rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-4">
              <div className="lab-eyebrow">Workspace</div>
              <div className="mt-2 text-sm font-semibold text-[var(--dls-text-primary)]">{selectedWorkspace?.displayName || selectedWorkspace?.name || selectedWorkspace?.id || "Unknown"}</div>
              <div className="mt-2 break-all text-xs text-[var(--dls-text-secondary)]">{workspaceRoot || "No workspace root reported"}</div>
            </div>
            <div className="rounded-[1.25rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-4">
              <div className="lab-eyebrow">Server</div>
              <div className="mt-2 text-sm font-semibold text-[var(--dls-text-primary)]">{status?.version || connection?.connection?.baseUrl || "Connected"}</div>
              <div className="mt-2 text-xs text-[var(--dls-text-secondary)]">
                Approval: {status?.approval?.mode || "unknown"}
                {typeof status?.approval?.timeoutMs === "number" ? ` · ${status.approval.timeoutMs}ms` : ""}
              </div>
            </div>
          </div>
        </section>

        <section className="lab-card space-y-4">
          <div>
            <div className="lab-eyebrow">Authorized folders</div>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">Control external directory access.</h3>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              className="lab-input"
              placeholder="/absolute/path/to/folder"
              value={authorizedFolderDraft}
              onChange={(event) => setAuthorizedFolderDraft(event.target.value)}
            />
            <button className="lab-button-primary" onClick={() => void addAuthorizedFolder()}>
              <FolderLock className="h-4 w-4" />
              Add folder
            </button>
          </div>
          <div className="space-y-3">
            {authorizedFolders.length ? (
              authorizedFolders.map((folder) => (
                <div key={folder} className="flex items-center justify-between gap-3 rounded-[1rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] px-4 py-3">
                  <div className="min-w-0 truncate text-sm text-[var(--dls-text-primary)]">{folder}</div>
                  <button className="lab-button-ghost !min-h-0 !px-3 !py-2" onClick={() => void removeAuthorizedFolder(folder)}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))
            ) : (
              <div className="lab-empty">No extra authorized folders are configured.</div>
            )}
          </div>
        </section>

        <section className="lab-card space-y-4">
          <div className="lab-eyebrow">Config snapshot</div>
          {configLoading ? (
            <div className="text-sm text-[var(--dls-text-secondary)]">Loading workspace config…</div>
          ) : configError ? (
            <div className="lab-error-banner">{configError}</div>
          ) : (
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap rounded-[1.25rem] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-4 text-xs leading-6 text-[var(--dls-text-primary)]">
              {JSON.stringify(config, null, 2)}
            </pre>
          )}
        </section>
      </div>

      <aside className="space-y-4">
        <section className="lab-stat-card space-y-4">
          <div className="lab-eyebrow">Capabilities</div>
          <div className="space-y-3 text-sm text-[var(--dls-text-secondary)]">
            <div>Config: {capabilities?.config?.write ? "read/write" : capabilities?.config?.read ? "read-only" : "unavailable"}</div>
            <div>OpenCode proxy: {capabilities?.proxy?.opencode ? "enabled" : "unavailable"}</div>
            <div>Files inbox: {capabilities?.toolProviders?.files?.injection ? "enabled" : "disabled"}</div>
          </div>
        </section>

        <section className="lab-stat-card space-y-4">
          <div className="lab-eyebrow">Connection</div>
          <button className="lab-button-danger w-full" onClick={() => void disconnect()}>
            <ArrowLeftRight className="h-4 w-4" />
            Disconnect and change workspace
          </button>
        </section>
      </aside>
    </section>
  );
}

export function LabShell() {
  const router = useRouter();
  const {
    booting,
    connection,
    connectionError,
    createSession,
    disconnect,
    refreshAll,
    selectedSessionId,
    selectSession,
    sessions,
    sessionsLoading,
    status,
    workspaceName,
  } = useLab();
  const [view, setView] = useState<View>("chat");

  const statusTone = !connection?.connected
    ? "danger"
    : status?.ok === false
      ? "warning"
      : "ready";

  if (booting) {
    return (
      <main className="lab-app-shell flex items-center justify-center">
        <div className="lab-card inline-flex items-center gap-3 text-sm text-[var(--dls-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Booting OpenWork Lab…
        </div>
      </main>
    );
  }

  if (!connection?.connected) {
    return (
      <main className="lab-app-shell flex items-center justify-center px-4">
        <div className="lab-card max-w-xl space-y-4">
          <div className="lab-eyebrow">Connection lost</div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">OpenWork Lab needs a reachable server.</h1>
          <p className="text-sm leading-7 text-[var(--dls-text-secondary)]">
            {connectionError || connection?.error || "Reconnect to one OpenWork workspace to keep using the lab shell."}
          </p>
          <div className="flex flex-wrap gap-3">
            <button className="lab-button-primary" onClick={() => router.push("/connect")}>
              <ArrowLeftRight className="h-4 w-4" />
              Go to connect screen
            </button>
            <button className="lab-button-secondary" onClick={() => void refreshAll()}>
              <RefreshCcw className="h-4 w-4" />
              Retry
            </button>
            <button className="lab-button-ghost" onClick={() => void disconnect()}>
              Clear saved connection
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="lab-app-shell">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <span className="lab-top-glow" />
        <span className="lab-side-glow" />
      </div>

      <div className="lab-shell-frame">
        <aside className="lab-sidebar-card flex min-h-0 flex-col gap-3 overflow-hidden !p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="lab-eyebrow">OpenWork Lab</div>
              <div className="mt-2 text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">{workspaceName}</div>
            </div>
            <div className="lab-badge">
              <Sparkles className="h-4 w-4 text-[var(--lab-blue)]" />
              single workspace
            </div>
          </div>

          <div className="lab-card space-y-3 !rounded-[1.2rem] !p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--dls-text-primary)]">Runtime status</div>
              <span className="lab-status-pill" data-tone={statusTone}>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-35" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-current" />
                </span>
                {status?.ok === false ? "Needs attention" : "Connected"}
              </span>
            </div>
            <div className="text-xs leading-6 text-[var(--dls-text-secondary)]">
              {connection.connection?.baseUrl}
            </div>
            <button className="lab-button-secondary w-full" onClick={() => void refreshAll()}>
              <RefreshCcw className="h-4 w-4" />
              Refresh lab state
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button className="lab-tab-button" data-active={view === "chat"} onClick={() => setView("chat")}>
              <TerminalSquare className="h-4 w-4" />
              Session
            </button>
            <button className="lab-tab-button" data-active={view === "file"} onClick={() => setView("file")}>
              <FileCode2 className="h-4 w-4" />
              File
            </button>
            <button className="lab-tab-button" data-active={view === "settings"} onClick={() => setView("settings")}>
              <Settings2 className="h-4 w-4" />
              Settings
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 px-1">
            <div>
              <div className="lab-eyebrow">Sessions</div>
              <div className="mt-1 text-sm text-[var(--dls-text-secondary)]">No quick switching, just one workspace history.</div>
            </div>
            <button className="lab-button-primary !min-h-0 !px-3 !py-2" onClick={() => void createSession()}>
              <Plus className="h-4 w-4" />
              New
            </button>
          </div>

          <div className="lab-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
            {sessionsLoading ? (
              <div className="lab-empty inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading sessions…
              </div>
            ) : sessions.length ? (
              sessions.map((session) => {
                const active = session.id === selectedSessionId;
                return (
                  <button
                    key={session.id}
                    className="rounded-[1rem] border px-3.5 py-2.5 text-left transition-all duration-150 hover:-translate-y-[1px]"
                    style={{
                      borderColor: active ? "rgba(79, 124, 255, 0.24)" : "var(--dls-border)",
                      background: active ? "rgba(238, 244, 255, 0.9)" : "rgba(255, 255, 255, 0.82)",
                    }}
                    onClick={() => void selectSession(session.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-[var(--dls-text-primary)]">
                          {session.title?.trim() || "Untitled session"}
                        </div>
                        <div className="mt-1.5 text-[11px] text-[var(--dls-text-secondary)]">
                          Updated {formatWhen(session.time?.updated ?? session.time?.created)}
                        </div>
                      </div>
                      <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-[var(--lab-blue)]" : "text-[var(--dls-text-secondary)]"}`} />
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="lab-empty">No sessions yet. Create one and start with the transcript.</div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col gap-4 overflow-hidden">
          <header className="lab-card flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="lab-eyebrow">Core shell</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--dls-text-primary)]">
                {view === "chat" ? "Readable session flow" : view === "file" ? "Workspace file editing" : "Server-backed settings"}
              </h1>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="lab-model-pill">
                <Bot className="h-4 w-4" />
                OpenWork server first
              </div>
              <div className="lab-model-pill">
                <Sparkles className="h-4 w-4" />
                den-web design language
              </div>
              {connectionError ? (
                <div className="lab-status-pill" data-tone="warning">
                  <AlertTriangle className="h-4 w-4" />
                  {connectionError}
                </div>
              ) : null}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden">
            {view === "chat" ? <SessionView /> : null}
            {view === "file" ? <FileView /> : null}
            {view === "settings" ? <SettingsView /> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
