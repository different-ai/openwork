/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { ArrowLeft, MonitorUp } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";
import { tagClass } from "./modal-styles";
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

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[78vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="flex-row">
          {activeView !== "chooser" ? (
            <Button
              onClick={goBack}
              variant="ghost"
              size="icon"
              aria-label={t("share.back_hint")}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{headerTitle}</DialogTitle>
              {activeView === "chooser" ? (
                <span className={tagClass}>{workspaceBadge}</span>
              ) : null}
            </div>
            <DialogDescription>{headerSubtitle}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
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
      </DialogContent>
    </Dialog>
  );
}
