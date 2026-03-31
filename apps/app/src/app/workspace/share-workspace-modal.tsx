import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { ArrowLeft, MonitorUp, Rocket, X } from "lucide-solid";

import ShareWorkspaceAccessPanel from "./share-workspace-access-panel";
import ShareWorkspaceTemplatePanel from "./share-workspace-template-panel";
import {
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalTitleClass,
  modalSubtitleClass,
  tagClass,
} from "./modal-styles";
import WorkspaceOptionCard from "./option-card";
import type { ShareView, ShareWorkspaceModalProps } from "./types";

export default function ShareWorkspaceModal(props: ShareWorkspaceModalProps) {
  const [activeView, setActiveView] = createSignal<ShareView>("chooser");
  const [revealedByKey, setRevealedByKey] = createSignal<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);
  const [collaboratorExpanded, setCollaboratorExpanded] = createSignal(false);
  const [remoteAccessEnabled, setRemoteAccessEnabled] = createSignal(false);
  const [teamTemplateName, setTeamTemplateName] = createSignal("");

  const title = createMemo(() => props.title ?? "Share workspace");
  const workspaceBadge = createMemo(() => {
    const raw = props.workspaceName?.trim() || "Workspace";
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || raw;
  });

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setActiveView("chooser");
        setRevealedByKey({});
        setCopiedKey(null);
        setCollaboratorExpanded(false);
        setRemoteAccessEnabled(props.remoteAccess?.enabled === true);
        setTeamTemplateName(`${props.workspaceName.trim() || "Workspace"} template`);
      },
    ),
  );

  createEffect(
    on(
      () => props.remoteAccess?.enabled,
      (enabled) => {
        if (!props.open) return;
        setRemoteAccessEnabled(enabled === true);
      },
    ),
  );

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const view = activeView();
      if (view === "chooser") {
        props.onClose();
        return;
      }
      if (view === "template-public" || view === "template-team") {
        setActiveView("template");
        return;
      }
      setActiveView("chooser");
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const goBack = () => {
    const view = activeView();
    if (view === "template-public" || view === "template-team") {
      setActiveView("template");
      return;
    }
    setActiveView("chooser");
  };

  const handleCopy = async (value: string, key: string) => {
    const text = value?.trim() ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      // ignore clipboard failures
    }
  };

  const headerTitle = createMemo(() => {
    switch (activeView()) {
      case "template":
        return "Share a template";
      case "template-public":
        return "Public template";
      case "template-team":
        return "Share with team";
      case "access":
        return "Access workspace remotely";
      default:
        return title();
    }
  });

  const headerSubtitle = createMemo(() => {
    switch (activeView()) {
      case "template":
        return "Share a reusable setup without granting live access to this running workspace.";
      case "template-public":
        return "Create a public workspace template link anyone can import.";
      case "template-team":
        return "Save a workspace template to your active OpenWork Cloud organization.";
      case "access":
        return "Reveal the live connection details needed to reach this workspace from another machine.";
      default:
        return props.workspaceDetail?.trim() || "Choose how you want to share this workspace.";
    }
  });

  return (
    <Show when={props.open}>
      <div class={`${modalOverlayClass} items-start pt-[10vh]`}>
        <div class={`${modalShellClass} max-h-[78vh] max-w-[640px]`} role="dialog" aria-modal="true">
          <div class={modalHeaderClass}>
            <div class="flex min-w-0 items-start gap-3">
              <Show when={activeView() !== "chooser"}>
                <button onClick={goBack} class={modalHeaderButtonClass} aria-label="Back">
                  <ArrowLeft size={16} />
                </button>
              </Show>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class={modalTitleClass}>{headerTitle()}</h2>
                  <Show when={activeView() === "chooser"}>
                    <span class={tagClass}>{workspaceBadge()}</span>
                  </Show>
                </div>
                <p class={modalSubtitleClass}>{headerSubtitle()}</p>
              </div>
            </div>

            <button onClick={props.onClose} class={modalHeaderButtonClass} aria-label="Close" title="Close">
              <X size={16} />
            </button>
          </div>

          <div class="flex-1 overflow-y-auto px-6 pb-7 pt-2 scrollbar-hide">
            <Show when={activeView() === "chooser"}>
              <div class="space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
                <WorkspaceOptionCard
                  title="Share a template"
                  description="Package this setup so someone else can start from the same environment."
                  icon={Rocket}
                  onClick={() => setActiveView("template")}
                />
                <WorkspaceOptionCard
                  title="Access workspace remotely"
                  description="Reveal the live connection details needed to reach this running workspace from another machine."
                  icon={MonitorUp}
                  onClick={() => setActiveView("access")}
                />
              </div>
            </Show>

            <Show
              when={
                activeView() === "template" ||
                activeView() === "template-public" ||
                activeView() === "template-team"
              }
            >
              <ShareWorkspaceTemplatePanel
                view={activeView()}
                setView={setActiveView}
                copiedKey={copiedKey()}
                onCopy={(value, key) => void handleCopy(value, key)}
                workspaceName={props.workspaceName}
                teamTemplateName={teamTemplateName()}
                onTeamTemplateNameInput={setTeamTemplateName}
                onShareWorkspaceProfile={props.onShareWorkspaceProfile}
                shareWorkspaceProfileBusy={props.shareWorkspaceProfileBusy}
                shareWorkspaceProfileUrl={props.shareWorkspaceProfileUrl}
                shareWorkspaceProfileError={props.shareWorkspaceProfileError}
                shareWorkspaceProfileDisabledReason={props.shareWorkspaceProfileDisabledReason}
                shareWorkspaceProfileSensitiveWarnings={props.shareWorkspaceProfileSensitiveWarnings}
                shareWorkspaceProfileSensitiveMode={props.shareWorkspaceProfileSensitiveMode}
                onShareWorkspaceProfileSensitiveModeChange={props.onShareWorkspaceProfileSensitiveModeChange}
                onShareWorkspaceProfileToTeam={props.onShareWorkspaceProfileToTeam}
                shareWorkspaceProfileToTeamBusy={props.shareWorkspaceProfileToTeamBusy}
                shareWorkspaceProfileToTeamError={props.shareWorkspaceProfileToTeamError}
                shareWorkspaceProfileToTeamSuccess={props.shareWorkspaceProfileToTeamSuccess}
                shareWorkspaceProfileToTeamDisabledReason={props.shareWorkspaceProfileToTeamDisabledReason}
                shareWorkspaceProfileToTeamOrgName={props.shareWorkspaceProfileToTeamOrgName}
                shareWorkspaceProfileToTeamNeedsSignIn={props.shareWorkspaceProfileToTeamNeedsSignIn}
                onShareWorkspaceProfileToTeamSignIn={props.onShareWorkspaceProfileToTeamSignIn}
                templateContentSummary={props.templateContentSummary}
              />
            </Show>

            <Show when={activeView() === "access"}>
              <ShareWorkspaceAccessPanel
                fields={props.fields}
                copiedKey={copiedKey()}
                onCopy={(value, key) => void handleCopy(value, key)}
                revealedByKey={revealedByKey()}
                onToggleReveal={(key) =>
                  setRevealedByKey((prev) => ({
                    ...prev,
                    [key]: !prev[key],
                  }))
                }
                collaboratorExpanded={collaboratorExpanded()}
                onToggleCollaboratorExpanded={() => setCollaboratorExpanded((value) => !value)}
                remoteAccess={props.remoteAccess}
                remoteAccessEnabled={remoteAccessEnabled()}
                onRemoteAccessEnabledChange={setRemoteAccessEnabled}
                note={props.note}
                onOpenBots={props.onOpenBots}
              />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
