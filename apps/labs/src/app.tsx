import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Streamdown } from "streamdown";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import { fetchTemplateProfile, builtInTemplates } from "./templates";
import { workspaceNameFromUrl } from "./opencode";
import type {
  LabsStarter,
  LabsTemplateProfile,
  MessageWithParts,
  SeedMessage,
  WorkspaceConnectionStatus,
} from "./types";
import { useLabsApp } from "./use-labs-app";

const DEFAULT_EMPTY_STATE = {
  title: "Where are my workspaces, what chats do I have, and how do I start from something useful?",
  body: "Create a workspace, open a template, or start typing.",
};

const synthesizeSeedMessages = (seedMessages: SeedMessage[]) =>
  seedMessages.map((seed, index) => ({
    info: {
      id: `seed-${index}`,
      sessionID: `seed-session-${index}`,
      role: seed.role,
      time: {
        created: index,
      },
    } as Message,
    parts: [
      {
        id: `seed-part-${index}`,
        messageID: `seed-${index}`,
        sessionID: `seed-session-${index}`,
        type: "text",
        text: seed.text,
      } as Part,
    ],
  })) satisfies MessageWithParts[];

const formatRelativeTime = (timestampMs?: number | null) => {
  if (!timestampMs) return "Just now";
  const delta = Date.now() - timestampMs;
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 60 * 60_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.max(1, Math.round(delta / (60 * 60_000)))}h ago`;
  return new Date(timestampMs).toLocaleDateString();
};

const sessionTitle = (session: Session | null | undefined) => {
  const title = typeof session?.title === "string" ? session.title.trim() : "";
  return title || "Untitled chat";
};

const workspaceInitials = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "OW";

const connectionLabel = (status: WorkspaceConnectionStatus) => {
  if (status === "connected") return "Live";
  if (status === "connecting") return "Checking";
  return "Offline";
};

export function App() {
  const labs = useLabsApp();
  const [composerText, setComposerText] = useState("");
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateUrl, setTemplateUrl] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<LabsTemplateProfile | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(builtInTemplates[0]?.id ?? "");
  const [templateTargetMode, setTemplateTargetMode] = useState<"current" | "existing" | "new">("current");
  const [templateWorkspaceId, setTemplateWorkspaceId] = useState<string>("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceUrl, setNewWorkspaceUrl] = useState("");
  const [newWorkspaceToken, setNewWorkspaceToken] = useState("");
  const [workspaceForm, setWorkspaceForm] = useState({
    name: "",
    baseUrl: "",
    token: "",
  });

  const activeWorkspace = labs.activeWorkspace;
  const activeSessions = labs.activeSessions;
  const selectedSessionId = labs.selectedSessionId;
  const selectedSession = useMemo(
    () => activeSessions.find((session) => session.id === selectedSessionId) ?? null,
    [activeSessions, selectedSessionId],
  );
  const activeConnection = activeWorkspace
    ? labs.state.connectionByWorkspaceId[activeWorkspace.id] ?? {
        status: "disconnected",
        message: "Not connected",
      }
    : null;
  const selectedSessionMessages = selectedSessionId
    ? labs.state.messagesBySessionId[selectedSessionId] ?? []
    : [];
  const selectedSeedMessages = selectedSessionId
    ? labs.state.seedMessagesBySessionId[selectedSessionId] ?? []
    : [];
  const visibleMessages = useMemo(() => {
    if (selectedSessionMessages.length > 0) return selectedSessionMessages;
    if (selectedSeedMessages.length > 0) return synthesizeSeedMessages(selectedSeedMessages);
    return [] as MessageWithParts[];
  }, [selectedSeedMessages, selectedSessionMessages]);
  const sessionBusy = selectedSessionId
    ? labs.state.statusBySessionId[selectedSessionId] === "busy"
    : false;
  const emptyState = activeWorkspace?.template?.blueprint.emptyState ?? DEFAULT_EMPTY_STATE;
  const starterCards = activeWorkspace?.template?.blueprint.emptyState.starters ?? [];

  const templateLibrary = useMemo(() => {
    const merged = [...builtInTemplates, ...labs.state.templates];
    const seen = new Set<string>();
    return merged.filter((template) => {
      const key = template.sourceUrl || template.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [labs.state.templates]);

  const displayTemplates = useMemo(() => {
    if (!previewTemplate) return templateLibrary;
    return [previewTemplate, ...templateLibrary.filter((template) => template.id !== previewTemplate.id)];
  }, [previewTemplate, templateLibrary]);

  const selectedTemplate =
    displayTemplates.find((template) => template.id === selectedTemplateId) ?? displayTemplates[0] ?? null;

  useEffect(() => {
    if (selectedTemplate) {
      setSelectedTemplateId(selectedTemplate.id);
    }
  }, [selectedTemplate]);

  useEffect(() => {
    if (!templateModalOpen) return;
    if (labs.activeWorkspace) {
      setTemplateTargetMode("current");
      setTemplateWorkspaceId(labs.activeWorkspace.id);
      setNewWorkspaceName("");
      setNewWorkspaceUrl("");
      setNewWorkspaceToken("");
    } else if (labs.state.workspaces.length > 0) {
      setTemplateTargetMode("existing");
      setTemplateWorkspaceId(labs.state.workspaces[0]?.id ?? "");
    } else {
      setTemplateTargetMode("new");
    }
  }, [labs.activeWorkspace, labs.state.workspaces, templateModalOpen]);

  const handleAddWorkspace = () => {
    setWorkspaceForm({
      name: "",
      baseUrl: "",
      token: "",
    });
    setWorkspaceModalOpen(true);
  };

  const handleWorkspaceSave = async () => {
    setWorkspaceBusy(true);
    let workspaceId: string | null = null;
    if (workspaceForm.baseUrl.trim()) {
      workspaceId = labs.saveWorkspace(workspaceForm);
    } else {
      workspaceId = await labs.createLocalWorkspace(workspaceForm.name);
    }
    setWorkspaceBusy(false);
    if (!workspaceId) return;
    setWorkspaceModalOpen(false);
    labs.setActiveWorkspace(workspaceId);
  };

  const handleFetchTemplate = async () => {
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      const template = await fetchTemplateProfile(templateUrl);
      setPreviewTemplate(template);
      setSelectedTemplateId(template.id);
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : String(error));
    } finally {
      setTemplateBusy(false);
    }
  };

  const handleApplyTemplate = async () => {
    if (!selectedTemplate) return;

    let workspaceId = activeWorkspace?.id ?? null;
    if (templateTargetMode === "existing") {
      workspaceId = templateWorkspaceId || null;
    }
    if (templateTargetMode === "new") {
      workspaceId = newWorkspaceUrl.trim()
        ? labs.saveWorkspace({
            name: newWorkspaceName,
            baseUrl: newWorkspaceUrl,
            token: newWorkspaceToken,
          })
        : await labs.createLocalWorkspace(newWorkspaceName);
    }

    if (!workspaceId) {
      setTemplateError("Choose where this template should land, or create a local workspace first.");
      return;
    }

    await labs.applyTemplateToWorkspace(workspaceId, selectedTemplate);
    labs.setActiveWorkspace(workspaceId);
    setTemplateModalOpen(false);
  };

  const handleSend = async () => {
    if (!activeWorkspace || !composerText.trim()) return;
    const sessionId = await labs.sendPrompt(activeWorkspace.id, selectedSessionId, composerText);
    if (sessionId) {
      setComposerText("");
      await labs.selectSession(activeWorkspace.id, sessionId);
    }
  };

  const handleStarter = async (starter: LabsStarter) => {
    if (!activeWorkspace) {
      if (starter.kind === "action") {
        setTemplateModalOpen(true);
      } else {
        setWorkspaceModalOpen(true);
      }
      return;
    }

    if (starter.kind === "prompt") {
      setComposerText(starter.prompt ?? starter.title);
      return;
    }

    if (starter.kind === "session") {
      const materialized = activeWorkspace.template?.blueprint.materialized.find(
        (item) => item.templateId === starter.id,
      );
      if (materialized) {
        await labs.selectSession(activeWorkspace.id, materialized.sessionId);
        return;
      }

      const sessionId = await labs.createSession(activeWorkspace.id);
      if (sessionId && starter.prompt) {
        await labs.sendPrompt(activeWorkspace.id, sessionId, starter.prompt);
        await labs.selectSession(activeWorkspace.id, sessionId);
      }
      return;
    }

    if (starter.kind === "action") {
      const nextAction = labs.openTemplateActionForStarter(activeWorkspace.id, starter.action);
      if (nextAction === "template-library") {
        setTemplateModalOpen(true);
      }
    }
  };

  const handleCopyTemplateLink = async () => {
    if (!activeWorkspace?.template?.sourceUrl) return;
    try {
      await navigator.clipboard.writeText(activeWorkspace.template.sourceUrl);
    } catch {
      // Ignore clipboard failures in the web fallback.
    }
  };

  const noWorkspaces = labs.state.workspaces.length === 0;
  const noSelectedSession = !selectedSessionId;
  const showStarterSurface = visibleMessages.length === 0;

  return (
    <div className="labs-shell">
      <div className="labs-glow labs-glow-a" />
      <div className="labs-glow labs-glow-b" />

      <aside className="workspace-rail" aria-label="Workspace switcher">
        <div className="workspace-rail-header">
          <span className="wordmark-mark">OW</span>
          <span className="wordmark-copy">Labs</span>
        </div>

        <div className="workspace-rail-stack">
          {labs.state.workspaces.map((workspace) => {
            const unread = labs.state.unreadByWorkspaceId[workspace.id] ?? 0;
            const selected = workspace.id === activeWorkspace?.id;
            return (
              <button
                key={workspace.id}
                type="button"
                className={selected ? "workspace-chip active" : "workspace-chip"}
                onClick={() => labs.setActiveWorkspace(workspace.id)}
                title={workspace.name}
                style={{ ["--workspace-color" as string]: workspace.color }}
              >
                <span className="workspace-chip-indicator" />
                <span className="workspace-chip-label">{workspaceInitials(workspace.name)}</span>
                {unread > 0 ? <span className="workspace-chip-badge">{Math.min(unread, 9)}</span> : null}
              </button>
            );
          })}
        </div>

        <button type="button" className="workspace-add" onClick={handleAddWorkspace}>
          +
        </button>
      </aside>

      <aside className="session-sidebar">
        <div className="session-sidebar-shell">
          <div className="sidebar-header">
            <div>
              <p className="eyebrow">Workspace</p>
              <h1>{activeWorkspace?.name ?? "Add your first workspace"}</h1>
            </div>
            <button type="button" className="secondary-button" onClick={() => setTemplateModalOpen(true)}>
              Templates
            </button>
          </div>

          <div className="connection-pill-row">
            <span className={`status-pill ${activeConnection?.status ?? "disconnected"}`}>
              {connectionLabel(activeConnection?.status ?? "disconnected")}
            </span>
            <span className="connection-copy">
              {activeConnection?.message || "Connect a workspace to see live sessions and streaming updates."}
            </span>
          </div>

          {activeWorkspace?.template ? (
            <div className="template-card compact">
              <div>
                <p className="eyebrow">Current template</p>
                <h2>{activeWorkspace.template.name}</h2>
                <p>{activeWorkspace.template.description}</p>
              </div>
              {activeWorkspace.template.sourceUrl ? (
                <button type="button" className="ghost-button" onClick={handleCopyTemplateLink}>
                  Copy link
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="sidebar-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => activeWorkspace && void labs.createSession(activeWorkspace.id)}
              disabled={!activeWorkspace}
            >
              New chat
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => activeWorkspace && void labs.refreshWorkspace(activeWorkspace.id)}
              disabled={!activeWorkspace}
            >
              Refresh
            </button>
          </div>

          <div className="session-list" aria-label="Sessions">
            {noWorkspaces ? (
              <div className="sidebar-empty">
                <p className="eyebrow">Start here</p>
                <h2>Connect a workspace</h2>
                 <p>
                    Labs is session-first. Use your local OpenCode server on localhost:4096, or connect an existing remote server and jump straight into the conversations inside it.
                  </p>
                <button type="button" className="primary-button" onClick={handleAddWorkspace}>
                  Add workspace
                </button>
              </div>
            ) : activeSessions.length === 0 ? (
              <div className="sidebar-empty compact-empty">
                <p>No chats yet for this workspace.</p>
              </div>
            ) : (
              activeSessions.map((session) => {
                const selected = session.id === selectedSessionId;
                const status = labs.state.statusBySessionId[session.id] ?? "idle";
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={selected ? "session-row active" : "session-row"}
                    onClick={() => activeWorkspace && void labs.selectSession(activeWorkspace.id, session.id)}
                  >
                    <span className="session-row-title">{sessionTitle(session)}</span>
                    <span className="session-row-meta">
                      {formatRelativeTime(session.time?.updated ?? session.time?.created)}
                    </span>
                    {status === "busy" ? <span className="session-row-status">Streaming</span> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </aside>

      <main className="thread-stage">
        <div className="thread-shell">
          <header className="thread-header">
            <div>
              <p className="eyebrow">Active chat</p>
              <h2>{selectedSession ? sessionTitle(selectedSession) : activeWorkspace?.name ?? "OpenWork Labs"}</h2>
            </div>

            <div className="thread-actions">
              <button type="button" className="secondary-button" onClick={() => setTemplateModalOpen(true)}>
                Open template
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => activeWorkspace && void labs.createSession(activeWorkspace.id)}
                disabled={!activeWorkspace}
              >
                New chat
              </button>
            </div>
          </header>

          {labs.state.error ? (
            <div className="error-banner">
              <span>{labs.state.error}</span>
              <button type="button" className="ghost-button" onClick={labs.clearError}>
                Dismiss
              </button>
            </div>
          ) : null}

          <section className="thread-body">
            {noWorkspaces ? (
              <OnboardingPanel onAddWorkspace={handleAddWorkspace} onOpenTemplates={() => setTemplateModalOpen(true)} />
            ) : showStarterSurface ? (
              <StarterSurface
                title={emptyState.title}
                body={emptyState.body}
                starters={starterCards}
                recommendation={activeWorkspace?.template?.recommendedDefaults ?? []}
                onStarter={handleStarter}
              />
            ) : (
              <MessageTimeline messages={visibleMessages} busy={sessionBusy} />
            )}
          </section>

          <footer className="composer-shell">
            <label className="composer-label" htmlFor="labs-composer">
              Message
            </label>
            <div className="composer-frame">
              <textarea
                id="labs-composer"
                className="composer-input"
                placeholder={
                  activeWorkspace
                    ? "Ask a question, paste rough notes, or start from a template action..."
                    : "Add a workspace to start chatting..."
                }
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={!activeWorkspace}
              />

              <div className="composer-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    activeWorkspace && selectedSessionId
                      ? void labs.abortSession(activeWorkspace.id, selectedSessionId)
                      : undefined
                  }
                  disabled={!activeWorkspace || !selectedSessionId || !sessionBusy}
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleSend()}
                  disabled={!activeWorkspace || !composerText.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </footer>
        </div>
      </main>

      {workspaceModalOpen ? (
        <ModalFrame title="Add workspace" subtitle="Leave the URL blank to use your local OpenCode server on localhost:4096, or paste a remote server URL.">
          <div className="modal-field-grid">
            <label className="modal-field">
              <span>Name</span>
              <input
                name="workspace-name"
                value={workspaceForm.name}
                onChange={(event) =>
                  setWorkspaceForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Client Ops"
              />
            </label>

            <label className="modal-field">
              <span>OpenCode server URL</span>
              <input
                name="workspace-url"
                value={workspaceForm.baseUrl}
                onChange={(event) =>
                  setWorkspaceForm((current) => ({ ...current, baseUrl: event.target.value }))
                }
                placeholder="https://worker.openworklabs.com/opencode"
              />
              <small className="modal-help">Leave this blank to use the local OpenCode server on localhost:4096.</small>
            </label>

            {workspaceForm.baseUrl.trim() ? (
              <label className="modal-field">
                <span>Access token</span>
                <input
                  name="workspace-token"
                  value={workspaceForm.token}
                  onChange={(event) =>
                    setWorkspaceForm((current) => ({ ...current, token: event.target.value }))
                  }
                  placeholder="Optional bearer token"
                  type="password"
                />
              </label>
            ) : null}
          </div>

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => setWorkspaceModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={() => void handleWorkspaceSave()} disabled={workspaceBusy}>
              {workspaceBusy
                ? "Creating..."
                : workspaceForm.baseUrl.trim()
                  ? "Connect workspace"
                  : "Create workspace"}
            </button>
          </div>
        </ModalFrame>
      ) : null}

      {templateModalOpen ? (
        <ModalFrame
          large
          title="Shared templates"
          subtitle="Preview a calm starting point, then land it in the workspace you want to use next."
        >
          <div className="template-modal-layout">
            <div className="template-catalog">
              <div className="template-fetch-row">
                <input
                  name="template-url"
                  value={templateUrl}
                  onChange={(event) => setTemplateUrl(event.target.value)}
                  placeholder="Paste a share.openworklabs.com bundle link"
                />
                <button type="button" className="secondary-button" onClick={() => void handleFetchTemplate()}>
                  {templateBusy ? "Loading..." : "Preview link"}
                </button>
              </div>
              {templateError ? <p className="field-error">{templateError}</p> : null}

              <div className="template-list">
                {displayTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={selectedTemplate?.id === template.id ? "template-list-item active" : "template-list-item"}
                    onClick={() => setSelectedTemplateId(template.id)}
                  >
                    <span className="eyebrow">{template.source === "builtin" ? "Built in" : "Shared"}</span>
                    <strong>{template.name}</strong>
                    <p>{template.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="template-preview-panel">
              {selectedTemplate ? (
                <>
                  <div className="template-card">
                    <div>
                      <p className="eyebrow">Template</p>
                      <h2>{selectedTemplate.name}</h2>
                      <p>{selectedTemplate.description}</p>
                    </div>
                    <div className="template-stat-grid">
                      <TemplateStat label="Starter chats" value={String(selectedTemplate.starterSessionCount)} />
                      <TemplateStat label="Starter actions" value={String(selectedTemplate.starterCount)} />
                      <TemplateStat label="Preset" value={selectedTemplate.preset} />
                    </div>
                  </div>

                  <div className="template-card-grid">
                    <TemplateChecklist title="Starter chats" items={selectedTemplate.blueprint.sessions.map((session) => session.title)} />
                    <TemplateChecklist title="Recommended defaults" items={selectedTemplate.recommendedDefaults} />
                    <TemplateChecklist title="Included items" items={selectedTemplate.includedItems} />
                  </div>

                  <div className="template-target-panel">
                    <p className="eyebrow">Apply to</p>
                    <div className="target-toggle-row">
                      <button
                        type="button"
                        className={templateTargetMode === "current" ? "target-toggle active" : "target-toggle"}
                        onClick={() => setTemplateTargetMode("current")}
                        disabled={!labs.activeWorkspace}
                      >
                        Current workspace
                      </button>
                      <button
                        type="button"
                        className={templateTargetMode === "existing" ? "target-toggle active" : "target-toggle"}
                        onClick={() => setTemplateTargetMode("existing")}
                        disabled={labs.state.workspaces.length === 0}
                      >
                        Existing workspace
                      </button>
                      <button
                        type="button"
                        className={templateTargetMode === "new" ? "target-toggle active" : "target-toggle"}
                        onClick={() => setTemplateTargetMode("new")}
                      >
                        New workspace
                      </button>
                    </div>

                    {templateTargetMode === "existing" ? (
                      <label className="modal-field">
                        <span>Workspace</span>
                        <select
                          value={templateWorkspaceId}
                          onChange={(event) => setTemplateWorkspaceId(event.target.value)}
                        >
                          {labs.state.workspaces.map((workspace) => (
                            <option key={workspace.id} value={workspace.id}>
                              {workspace.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {templateTargetMode === "new" ? (
                      <div className="modal-field-grid compact-grid">
                        <label className="modal-field">
                          <span>Name</span>
                          <input
                            name="new-workspace-name"
                            value={newWorkspaceName}
                            onChange={(event) => setNewWorkspaceName(event.target.value)}
                            placeholder={workspaceNameFromUrl(newWorkspaceUrl) || "OpenWork workspace"}
                          />
                        </label>
                        <label className="modal-field">
                          <span>OpenCode server URL</span>
                          <input
                            name="new-workspace-url"
                            value={newWorkspaceUrl}
                            onChange={(event) => setNewWorkspaceUrl(event.target.value)}
                            placeholder="https://worker.openworklabs.com/opencode"
                          />
                          <small className="modal-help">Leave this blank to use the local OpenCode server on localhost:4096.</small>
                        </label>
                        {newWorkspaceUrl.trim() ? (
                          <label className="modal-field">
                            <span>Access token</span>
                            <input
                              name="new-workspace-token"
                              type="password"
                              value={newWorkspaceToken}
                              onChange={(event) => setNewWorkspaceToken(event.target.value)}
                              placeholder="Optional bearer token"
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => setTemplateModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={() => void handleApplyTemplate()}>
              Use template
            </button>
          </div>
        </ModalFrame>
      ) : null}
    </div>
  );
}

function OnboardingPanel(props: {
  onAddWorkspace: () => void;
  onOpenTemplates: () => void;
}) {
  return (
    <div className="onboarding-panel">
      <div className="onboarding-card primary-surface">
        <p className="eyebrow">OpenWork Labs</p>
        <h1>Calm, session-first chat for real workspaces.</h1>
        <p>
          Labs keeps the surface small: workspaces on the left, chats in the middle, templates when you need a useful starting point.
        </p>
        <div className="onboarding-actions">
          <button type="button" className="primary-button" onClick={props.onAddWorkspace}>
            Add workspace
          </button>
          <button type="button" className="secondary-button" onClick={props.onOpenTemplates}>
            Browse templates
          </button>
        </div>
      </div>

      <div className="onboarding-grid">
        <div className="onboarding-card">
          <p className="eyebrow">Multi-workspace</p>
          <h2>One OpenCode server per workspace.</h2>
          <p>Switch contexts instantly and let background workspaces keep quietly receiving updates.</p>
        </div>
        <div className="onboarding-card">
          <p className="eyebrow">Shared templates</p>
          <h2>Use starter chats you can trust.</h2>
          <p>Preview the template before you apply it, then land it into the workspace that needs it.</p>
        </div>
      </div>
    </div>
  );
}

function StarterSurface(props: {
  title: string;
  body: string;
  starters: LabsStarter[];
  recommendation: string[];
  onStarter: (starter: LabsStarter) => void;
}) {
  return (
    <div className="starter-surface">
      <div className="starter-copy">
        <p className="eyebrow">Start here</p>
        <h2>{props.title}</h2>
        <p>{props.body}</p>
      </div>

      {props.recommendation.length > 0 ? (
        <div className="recommendation-row">
          {props.recommendation.map((item) => (
            <span key={item} className="recommendation-pill">
              {item}
            </span>
          ))}
        </div>
      ) : null}

      <div className="starter-grid">
        {props.starters.map((starter) => (
          <button key={starter.id} type="button" className="starter-card" onClick={() => props.onStarter(starter)}>
            <span className="eyebrow">{starter.kind}</span>
            <strong>{starter.title}</strong>
            <p>{starter.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageTimeline(props: { messages: MessageWithParts[]; busy: boolean }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: props.messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 132,
    overscan: 6,
    useFlushSync: false,
    getItemKey: (index) => props.messages[index]?.info.id ?? `message-${index}`,
  });

  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;

    const onScroll = () => {
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      shouldStickToBottomRef.current = remaining < 160;
    };

    onScroll();
    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    const element = parentRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [props.busy, props.messages]);

  return (
    <div ref={parentRef} className="message-scroll-region">
      <div
        className="message-virtual-spacer"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const message = props.messages[row.index];
          const isUser = message.info.role === "user";
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              className="message-row"
              data-user={isUser ? "true" : "false"}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <article className={isUser ? "message-card user" : "message-card assistant"}>
                <div className="message-meta">
                  <span>{isUser ? "You" : "Labs"}</span>
                  <span>{formatRelativeTime(message.info.time?.created)}</span>
                </div>
                <div className="message-parts">
                  {message.parts.map((part) => (
                    <MessagePart key={part.id} part={part} busy={props.busy && !isUser} />
                  ))}
                </div>
              </article>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessagePart(props: { part: Part; busy: boolean }) {
  const record = props.part as Part & Record<string, unknown>;

  if (record.type === "text") {
    return (
      <Streamdown className="stream-markdown" isAnimating={props.busy}>
        {String(record.text ?? "")}
      </Streamdown>
    );
  }

  if (record.type === "reasoning") {
    return (
      <details className="reasoning-card">
        <summary>Thinking</summary>
        <div className="reasoning-body">{String(record.text ?? "")}</div>
      </details>
    );
  }

  if (record.type === "tool") {
    const state = (record.state as Record<string, unknown> | undefined) ?? {};
    return (
      <div className="tool-card">
        <div className="tool-card-header">
          <strong>{String(record.tool ?? "Tool")}</strong>
          <span>{String(state.status ?? "running")}</span>
        </div>
        {state.output ? <p>{String(state.output)}</p> : null}
      </div>
    );
  }

  return <pre className="part-fallback">{JSON.stringify(record, null, 2)}</pre>;
}

function ModalFrame(props: {
  title: string;
  subtitle: string;
  large?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop">
      <div className={props.large ? "modal-frame large" : "modal-frame"}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">OpenWork Labs</p>
            <h2>{props.title}</h2>
            <p>{props.subtitle}</p>
          </div>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function TemplateChecklist(props: { title: string; items: string[] }) {
  return (
    <div className="template-checklist">
      <p className="eyebrow">{props.title}</p>
      <ul>
        {props.items.length > 0 ? (
          props.items.map((item) => <li key={item}>{item}</li>)
        ) : (
          <li>Nothing extra yet</li>
        )}
      </ul>
    </div>
  );
}

function TemplateStat(props: { label: string; value: string }) {
  return (
    <div className="template-stat">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
