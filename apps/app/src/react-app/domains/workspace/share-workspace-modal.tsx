/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { ArrowLeft, MonitorUp, X } from "lucide-react";

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
import type { ShareView, ShareWorkspaceModalProps } from "./types";

type ShareWorkspaceModalState = {
  activeView: ShareView;
  revealedByKey: Record<string, boolean>;
  copiedKey: string | null;
  collaboratorExpanded: boolean;
  remoteAccessEnabled: boolean;
};

type ShareWorkspaceModalAction =
  | { type: "reset"; remoteAccessEnabled: boolean }
  | { type: "setActiveView"; view: ShareView }
  | { type: "toggleReveal"; key: string }
  | { type: "setCopiedKey"; key: string | null }
  | { type: "clearCopiedKey"; key: string }
  | { type: "toggleCollaboratorExpanded" }
  | { type: "setRemoteAccessEnabled"; enabled: boolean };

const initialShareWorkspaceModalState: ShareWorkspaceModalState = {
  activeView: "chooser",
  revealedByKey: {},
  copiedKey: null,
  collaboratorExpanded: false,
  remoteAccessEnabled: false,
};

function shareWorkspaceModalReducer(
  state: ShareWorkspaceModalState,
  action: ShareWorkspaceModalAction,
): ShareWorkspaceModalState {
  switch (action.type) {
    case "reset":
      return {
        activeView: "chooser",
        revealedByKey: {},
        copiedKey: null,
        collaboratorExpanded: false,
        remoteAccessEnabled: action.remoteAccessEnabled,
      };
    case "setActiveView":
      return { ...state, activeView: action.view };
    case "toggleReveal":
      return {
        ...state,
        revealedByKey: {
          ...state.revealedByKey,
          [action.key]: !state.revealedByKey[action.key],
        },
      };
    case "setCopiedKey":
      return { ...state, copiedKey: action.key };
    case "clearCopiedKey":
      return {
        ...state,
        copiedKey: state.copiedKey === action.key ? null : state.copiedKey,
      };
    case "toggleCollaboratorExpanded":
      return {
        ...state,
        collaboratorExpanded: !state.collaboratorExpanded,
      };
    case "setRemoteAccessEnabled":
      return { ...state, remoteAccessEnabled: action.enabled };
  }
}

export function ShareWorkspaceModal(props: ShareWorkspaceModalProps) {
  const [state, dispatch] = useReducer(
    shareWorkspaceModalReducer,
    initialShareWorkspaceModalState,
  );
  const {
    activeView,
    revealedByKey,
    copiedKey,
    collaboratorExpanded,
    remoteAccessEnabled,
  } = state;

  const title = props.title ?? t("share.title");
  const workspaceBadge = useMemo(() => {
    const raw = props.workspaceName?.trim() || t("share.workspace_fallback");
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || raw;
  }, [props.workspaceName]);

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (!props.open) return;
    dispatch({
      type: "reset",
      remoteAccessEnabled: props.remoteAccess?.enabled === true,
    });
  }, [props.open, props.remoteAccess?.enabled, props.workspaceName]);

  // Escape key handling: chooser closes the modal, sub-views step back.
  useEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (activeView === "chooser") {
        props.onClose();
        return;
      }
      dispatch({ type: "setActiveView", view: "chooser" });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, props]);

  const goBack = useCallback(() => {
    dispatch({ type: "setActiveView", view: "chooser" });
  }, []);

  const handleCopy = useCallback(async (value: string, key: string) => {
    const text = value?.trim() ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      dispatch({ type: "setCopiedKey", key });
      window.setTimeout(() => {
        dispatch({ type: "clearCopiedKey", key });
      }, 2000);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  const headerTitle = (() => {
    switch (activeView) {
      case "access":
        return t("share.view_access");
      default:
        return title;
    }
  })();

  const headerSubtitle = (() => {
    switch (activeView) {
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
                title={t("share.option_access_title")}
                description={t("share.option_access_desc")}
                icon={MonitorUp}
                onClick={() => dispatch({ type: "setActiveView", view: "access" })}
              />
            </div>
          ) : null}

          {activeView === "access" ? (
            <ShareWorkspaceAccessPanel
              fields={props.fields}
              copiedKey={copiedKey}
              onCopy={(value, key) => void handleCopy(value, key)}
              revealedByKey={revealedByKey}
              onToggleReveal={(key) => dispatch({ type: "toggleReveal", key })}
              collaboratorExpanded={collaboratorExpanded}
              onToggleCollaboratorExpanded={() =>
                dispatch({ type: "toggleCollaboratorExpanded" })
              }
              remoteAccess={props.remoteAccess}
              remoteAccessEnabled={remoteAccessEnabled}
              onRemoteAccessEnabledChange={(enabled) =>
                dispatch({ type: "setRemoteAccessEnabled", enabled })
              }
              note={props.note}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
