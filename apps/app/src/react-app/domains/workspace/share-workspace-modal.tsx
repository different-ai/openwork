/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, MonitorUp, Rocket, X } from "lucide-react";

import { t } from "../../../i18n";
import {
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalSubtitleClass,
  modalTitleClass,
  tagClass,
} from "./modal-styles";
import { WorkspaceOptionCard } from "./option-card";
import { ShareWorkspaceAccessPanel } from "./share-workspace-access-panel";
import { ShareWorkspaceTemplatePanel } from "./share-workspace-template-panel";
import type { ShareView, ShareWorkspaceModalProps } from "./types";

export function ShareWorkspaceModal(props: ShareWorkspaceModalProps) {
  const [activeView, setActiveView] = useState<ShareView>("chooser");
  const [revealedByKey, setRevealedByKey] = useState<Record<string, boolean>>(
    {},
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [collaboratorExpanded, setCollaboratorExpanded] = useState(false);
  const [remoteAccessEnabled, setRemoteAccessEnabled] = useState(false);
  const [teamTemplateName, setTeamTemplateName] = useState("");

  const title = props.title ?? t("share.title");
  const workspaceBadge = useMemo(() => {
    const raw = props.workspaceName?.trim() || t("share.workspace_fallback");
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || raw;
  }, [props.workspaceName]);

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (!props.open) return;
    setActiveView("chooser");
    setRevealedByKey({});
    setCopiedKey(null);
    setCollaboratorExpanded(false);
    setRemoteAccessEnabled(props.remoteAccess?.enabled === true);
    setTeamTemplateName(
      `${props.workspaceName.trim() || t("share.workspace_fallback")} template`,
    );
  }, [props.open, props.remoteAccess?.enabled, props.workspaceName]);

  // Mirror remote-access-enabled changes from the parent while open.
  useEffect(() => {
    if (!props.open) return;
    setRemoteAccessEnabled(props.remoteAccess?.enabled === true);
  }, [props.open, props.remoteAccess?.enabled]);

  // Escape key handling: chooser closes the modal, sub-views step back.
  useEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setActiveView((view) => {
        if (view === "chooser") {
          props.onClose();
          return view;
        }
        if (view === "template-public" || view === "template-team") {
          return "template";
        }
        return "chooser";
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props]);

  const goBack = useCallback(() => {
    setActiveView((view) => {
      if (view === "template-public" || view === "template-team") {
        return "template";
      }
      return "chooser";
    });
  }, []);

  const handleCopy = useCallback(async (value: string, key: string) => {
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
  }, []);

  const headerTitle = (() => {
    switch (activeView) {
      case "template":
        return t("share.view_template");
      case "template-public":
        return t("share.view_template_public");
      case "template-team":
        return t("share.view_template_team");
      case "access":
        return t("share.view_access");
      default:
        return title;
    }
  })();

  const headerSubtitle = (() => {
    switch (activeView) {
      case "template":
        return t("share.template_intro");
      case "template-public":
        return t("share.subtitle_template_public");
      case "template-team":
        return t("share.subtitle_template_team");
      case "access":
        return t("share.subtitle_access");
      default:
        return props.workspaceDetail?.trim() || t("share.chooser_subtitle");
    }
  })();

  if (!props.open) return null;

  return (
    <div className={`${modalOverlayClass} items-start pt-[10vh]`}>
      <div
        className={`${modalShellClass} max-h-[78vh] max-w-[640px]`}
        role="dialog"
        aria-modal="true"
      >
        <div className={modalHeaderClass}>
          <div className="flex min-w-0 items-start gap-3">
            {activeView !== "chooser" ? (
              <button
                onClick={goBack}
                className={modalHeaderButtonClass}
                aria-label={t("share.back_hint")}
              >
                <ArrowLeft size={16} />
              </button>
            ) : null}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className={modalTitleClass}>{headerTitle}</h2>
                {activeView === "chooser" ? (
                  <span className={tagClass}>{workspaceBadge}</span>
                ) : null}
              </div>
              <p className={modalSubtitleClass}>{headerSubtitle}</p>
            </div>
          </div>
          <button
            onClick={props.onClose}
            className={modalHeaderButtonClass}
            aria-label={t("share.close_hint")}
            title={t("share.close_hint")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-7 pt-2 scrollbar-hide">
          {activeView === "chooser" ? (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
              <WorkspaceOptionCard
                title={t("share.option_template_title")}
                description={t("share.option_template_desc")}
                icon={Rocket}
                onClick={() => setActiveView("template")}
              />
              <WorkspaceOptionCard
                title={t("share.option_access_title")}
                description={t("share.option_access_desc")}
                icon={MonitorUp}
                onClick={() => setActiveView("access")}
              />
            </div>
          ) : null}

          {activeView === "template" ||
          activeView === "template-public" ||
          activeView === "template-team" ? (
            <ShareWorkspaceTemplatePanel
              view={activeView}
              setView={setActiveView}
              copiedKey={copiedKey}
              onCopy={(value, key) => void handleCopy(value, key)}
              workspaceName={props.workspaceName}
              teamTemplateName={teamTemplateName}
              onTeamTemplateNameInput={setTeamTemplateName}
              onShareWorkspaceProfile={props.onShareWorkspaceProfile}
              shareWorkspaceProfileBusy={props.shareWorkspaceProfileBusy}
              shareWorkspaceProfileUrl={props.shareWorkspaceProfileUrl}
              shareWorkspaceProfileError={props.shareWorkspaceProfileError}
              shareWorkspaceProfileDisabledReason={
                props.shareWorkspaceProfileDisabledReason
              }
              shareWorkspaceProfileSensitiveWarnings={
                props.shareWorkspaceProfileSensitiveWarnings
              }
              shareWorkspaceProfileSensitiveMode={
                props.shareWorkspaceProfileSensitiveMode
              }
              onShareWorkspaceProfileSensitiveModeChange={
                props.onShareWorkspaceProfileSensitiveModeChange
              }
              onShareWorkspaceProfileToTeam={
                props.onShareWorkspaceProfileToTeam
              }
              shareWorkspaceProfileToTeamBusy={
                props.shareWorkspaceProfileToTeamBusy
              }
              shareWorkspaceProfileToTeamError={
                props.shareWorkspaceProfileToTeamError
              }
              shareWorkspaceProfileToTeamSuccess={
                props.shareWorkspaceProfileToTeamSuccess
              }
              shareWorkspaceProfileToTeamDisabledReason={
                props.shareWorkspaceProfileToTeamDisabledReason
              }
              shareWorkspaceProfileToTeamOrgName={
                props.shareWorkspaceProfileToTeamOrgName
              }
              shareWorkspaceProfileToTeamNeedsSignIn={
                props.shareWorkspaceProfileToTeamNeedsSignIn
              }
              onShareWorkspaceProfileToTeamSignIn={
                props.onShareWorkspaceProfileToTeamSignIn
              }
              templateContentSummary={props.templateContentSummary}
            />
          ) : null}

          {activeView === "access" ? (
            <ShareWorkspaceAccessPanel
              fields={props.fields}
              copiedKey={copiedKey}
              onCopy={(value, key) => void handleCopy(value, key)}
              revealedByKey={revealedByKey}
              onToggleReveal={(key) =>
                setRevealedByKey((prev) => ({
                  ...prev,
                  [key]: !prev[key],
                }))
              }
              collaboratorExpanded={collaboratorExpanded}
              onToggleCollaboratorExpanded={() =>
                setCollaboratorExpanded((value) => !value)
              }
              remoteAccess={props.remoteAccess}
              remoteAccessEnabled={remoteAccessEnabled}
              onRemoteAccessEnabledChange={setRemoteAccessEnabled}
              note={props.note}
              onOpenBots={props.onOpenBots}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
