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
  oauthExpanded: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  command: string;
  error: string | null;
  submitting: boolean;
};

const initialAddMcpState: AddMcpState = {
  name: "",
  serverType: "remote",
  url: "",
  oauthExpanded: false,
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScope: "",
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
      const oauthClientId = state.oauthClientId.trim();
      const oauthClientSecret = state.oauthClientSecret.trim();
      const oauthScope = state.oauthScope.trim();
      if (!trimmedUrl) {
        dispatch({ error: t("mcp.url_or_command_required"), submitting: false });
        return;
      }
      if (!oauthClientId && (oauthClientSecret || oauthScope)) {
        dispatch({ error: t("mcp.oauth_client_id_required"), submitting: false });
        return;
      }

      const oauthConfig = oauthClientId
        ? {
            clientId: oauthClientId,
            ...(oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
            ...(oauthScope ? { scope: oauthScope } : {}),
          }
        : undefined;

      try {
        await Promise.resolve(
          props.onAdd({
            name: trimmedName,
            description: "",
            type: "remote",
            url: trimmedUrl,
            oauth: Boolean(oauthConfig),
            ...(oauthConfig ? { oauthConfig } : {}),
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
              <div className="rounded-xl border border-dls-border bg-dls-hover/30">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-dls-text"
                  onClick={() => dispatch({ oauthExpanded: !state.oauthExpanded })}
                >
                  <span>{t("mcp.oauth_advanced_title")}</span>
                  <span className="text-dls-secondary">{state.oauthExpanded ? "-" : "+"}</span>
                </button>
                {state.oauthExpanded ? (
                  <div className="space-y-3 border-t border-dls-border px-3 py-3">
                    <div className="text-[11px] leading-relaxed text-dls-secondary">
                      {t("mcp.oauth_advanced_hint")}
                    </div>
                    <TextInput
                      label={t("mcp.oauth_client_id")}
                      placeholder={t("mcp.oauth_client_id_placeholder")}
                      value={state.oauthClientId}
                      onChange={(event) => dispatch({ oauthClientId: event.currentTarget.value })}
                    />
                    <TextInput
                      label={t("mcp.oauth_client_secret")}
                      placeholder={t("mcp.oauth_client_secret_placeholder")}
                      type="password"
                      value={state.oauthClientSecret}
                      onChange={(event) => dispatch({ oauthClientSecret: event.currentTarget.value })}
                    />
                    <TextInput
                      label={t("mcp.oauth_scope")}
                      placeholder={t("mcp.oauth_scope_placeholder")}
                      value={state.oauthScope}
                      onChange={(event) => dispatch({ oauthScope: event.currentTarget.value })}
                    />
                    <div className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-[11px] leading-relaxed text-amber-11">
                      {t("mcp.oauth_secret_warning")}
                    </div>
                  </div>
                ) : null}
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
