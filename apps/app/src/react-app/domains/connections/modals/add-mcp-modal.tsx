/** @jsxImportSource react */
import { useReducer } from "react";
import { Loader2, Plus } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import type { McpDirectoryInfo } from "@/app/constants";
import { t } from "@/i18n";

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: McpDirectoryInfo) => void;
  busy: boolean;
  isRemoteWorkspace: boolean;
};

type AddMcpState = {
  name: string;
  serverType: "remote" | "local";
  url: string;
  command: string;
  error: string | null;
  submitting: boolean;
};

const initialAddMcpState: AddMcpState = {
  name: "",
  serverType: "remote",
  url: "",
  command: "",
  error: null,
  submitting: false,
};

function addMcpReducer(state: AddMcpState, patch: Partial<AddMcpState> | "reset") {
  if (patch === "reset") return initialAddMcpState;
  return { ...state, ...patch };
}

export function AddMcpModal(props: AddMcpModalProps) {
  const [state, dispatch] = useReducer(addMcpReducer, initialAddMcpState);

  const reset = () => {
    dispatch("reset");
  };

  const handleClose = () => {
    if (state.submitting) return;
    reset();
    props.onClose();
  };

  const handleSubmit = async () => {
    if (state.submitting) return;
    dispatch({ error: null });

    const trimmedName = state.name.trim();
    if (!trimmedName) {
      dispatch({ error: t("mcp.name_required") });
      return;
    }

    dispatch({ submitting: true });

    if (state.serverType === "remote") {
      const trimmedUrl = state.url.trim();
      if (!trimmedUrl) {
        dispatch({ error: t("mcp.url_or_command_required"), submitting: false });
        return;
      }

      try {
        await Promise.resolve(
          props.onAdd({
            name: trimmedName,
            description: "",
            type: "remote",
            url: trimmedUrl,
            // Sign-in is auto-detected after connecting; the engine reports
            // needs_auth for OAuth servers and the sign-in modal opens itself.
            oauth: false,
          }),
        );
      } finally {
        dispatch({ submitting: false });
      }
    } else {
      const trimmedCommand = state.command.trim();
      if (!trimmedCommand) {
        dispatch({ error: t("mcp.url_or_command_required"), submitting: false });
        return;
      }

      try {
        await Promise.resolve(
          props.onAdd({
            name: trimmedName,
            description: "",
            type: "local",
            command: trimmedCommand.split(/\s+/),
            oauth: false,
          }),
        );
      } finally {
        dispatch({ submitting: false });
      }
    }

    handleClose();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("mcp.add_modal_title")}
          </DialogTitle>
          <DialogDescription>
            {t("mcp.add_modal_subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <TextInput
            label={t("mcp.server_name")}
            placeholder={t("mcp.server_name_placeholder")}
            value={state.name}
            onChange={(event) => dispatch({ name: event.currentTarget.value })}
          />

          <div>
            <div className="mb-1 text-xs font-medium text-dls-secondary">
              {t("mcp.server_type")}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  state.serverType === "remote"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                }`}
                onClick={() => dispatch({ serverType: "remote" })}
              >
                {t("mcp.type_remote")}
              </button>
              <button
                type="button"
                disabled={props.isRemoteWorkspace}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  state.serverType === "local"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                } ${props.isRemoteWorkspace ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => {
                  if (props.isRemoteWorkspace) return;
                  dispatch({ serverType: "local" });
                }}
              >
                {t("mcp.type_local_cmd")}
              </button>
            </div>
            {props.isRemoteWorkspace ? (
              <div className="mt-2 text-[11px] text-dls-secondary">
                {t("mcp.remote_workspace_url_hint")}
              </div>
            ) : null}
          </div>

          {state.serverType === "remote" ? (
            <div className="space-y-3">
              <TextInput
                label={t("mcp.server_url")}
                placeholder={t("mcp.server_url_placeholder")}
                value={state.url}
                onChange={(event) => dispatch({ url: event.currentTarget.value })}
              />
              <div className="text-[11px] text-dls-secondary">
                {t("mcp.oauth_autodetect_hint")}
              </div>
            </div>
          ) : null}

          {state.serverType === "local" ? (
            <TextInput
              label={t("mcp.server_command")}
              placeholder={t("mcp.server_command_placeholder")}
              hint={t("mcp.server_command_hint")}
              value={state.command}
              onChange={(event) => dispatch({ command: event.currentTarget.value })}
            />
          ) : null}

          {state.error ? (
            <div className="rounded-lg bg-red-2 border border-red-6 px-3 py-2 text-xs text-red-11">
              {state.error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          <DialogClose
            render={<Button variant="outline" disabled={state.submitting} />}
            disabled={state.submitting}
          >
            {t("mcp.auth.cancel")}
          </DialogClose>
          <Button
            onClick={() => void handleSubmit()}
            disabled={props.busy || state.submitting}
          >
            {props.busy || state.submitting ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            {t("mcp.add_server_button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
