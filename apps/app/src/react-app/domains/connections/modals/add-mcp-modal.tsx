/** @jsxImportSource react */
import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";
import type { McpDirectoryInfo } from "../../../../app/constants";
import { t, type Language } from "../../../../i18n";

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: McpDirectoryInfo) => void;
  busy: boolean;
  isRemoteWorkspace: boolean;
  language: Language;
};

export function AddMcpModal(props: AddMcpModalProps) {
  const tr = (key: string) => t(key, props.language);

  const [name, setName] = useState("");
  const [serverType, setServerType] = useState<"remote" | "local">("remote");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [oauthRequired, setOauthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName("");
    setServerType("remote");
    setUrl("");
    setCommand("");
    setOauthRequired(false);
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    props.onClose();
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(tr("mcp.name_required"));
      return;
    }

    setSubmitting(true);

    if (serverType === "remote") {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setError(tr("mcp.url_or_command_required"));
        setSubmitting(false);
        return;
      }

      try {
        await Promise.resolve(
          props.onAdd({
            name: trimmedName,
            description: "",
            type: "remote",
            url: trimmedUrl,
            oauth: oauthRequired,
          }),
        );
      } finally {
        setSubmitting(false);
      }
    } else {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        setError(tr("mcp.url_or_command_required"));
        setSubmitting(false);
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
        setSubmitting(false);
      }
    }

    handleClose();
  };

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-gray-1/60 backdrop-blur-sm"
        onClick={handleClose}
      />
      <div
        className="relative w-full max-w-lg bg-gray-2 border border-gray-6 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-12">
              {tr("mcp.add_modal_title")}
            </h2>
            <p className="text-sm text-gray-11">
              {tr("mcp.add_modal_subtitle")}
            </p>
          </div>
          <button
            type="button"
            className="p-2 text-gray-11 hover:text-gray-12 hover:bg-gray-4 rounded-lg transition-colors"
            onClick={handleClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <TextInput
            label={tr("mcp.server_name")}
            placeholder={tr("mcp.server_name_placeholder")}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoFocus
          />

          <div>
            <div className="mb-1 text-xs font-medium text-dls-secondary">
              {tr("mcp.server_type")}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  serverType === "remote"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                }`}
                onClick={() => setServerType("remote")}
              >
                {tr("mcp.type_remote")}
              </button>
              <button
                type="button"
                disabled={props.isRemoteWorkspace}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  serverType === "local"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                } ${props.isRemoteWorkspace ? "opacity-50 cursor-not-allowed" : ""}`}
                onClick={() => {
                  if (props.isRemoteWorkspace) return;
                  setServerType("local");
                }}
              >
                {tr("mcp.type_local_cmd")}
              </button>
            </div>
            {props.isRemoteWorkspace ? (
              <div className="mt-2 text-[11px] text-dls-secondary">
                {tr("mcp.remote_workspace_url_hint")}
              </div>
            ) : null}
          </div>

          {serverType === "remote" ? (
            <div className="space-y-3">
              <TextInput
                label={tr("mcp.server_url")}
                placeholder={tr("mcp.server_url_placeholder")}
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
              />
              <div className="rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-3">
                <div className="mb-2 text-xs font-medium text-dls-text">
                  {tr("mcp.sign_in_section_label")}
                </div>
                <label className="flex items-start gap-2 text-xs text-dls-secondary">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border border-dls-border"
                    checked={oauthRequired}
                    onChange={(event) =>
                      setOauthRequired(event.currentTarget.checked)
                    }
                  />
                  <span>
                    <span className="block text-dls-text">
                      {tr("mcp.oauth_optional_label")}
                    </span>
                    <span className="mt-0.5 block text-dls-secondary">
                      {tr("mcp.oauth_optional_hint")}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          ) : null}

          {serverType === "local" ? (
            <TextInput
              label={tr("mcp.server_command")}
              placeholder={tr("mcp.server_command_placeholder")}
              hint={tr("mcp.server_command_hint")}
              value={command}
              onChange={(event) => setCommand(event.currentTarget.value)}
            />
          ) : null}

          {error ? (
            <div className="rounded-lg bg-red-2 border border-red-6 px-3 py-2 text-xs text-red-11">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-6 bg-gray-2/50">
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={submitting}
          >
            {tr("mcp.auth.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleSubmit()}
            disabled={props.busy || submitting}
          >
            {props.busy || submitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Plus size={16} />
            )}
            {tr("mcp.add_server_button")}
          </Button>
        </div>
      </div>
    </div>
  );
}
