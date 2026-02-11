import { Show, createSignal } from "solid-js";
import { Loader2, Plus, X } from "lucide-solid";
import Button from "./button";
import TextInput from "./text-input";
import type { McpDirectoryInfo } from "../constants";
import { t, type Language } from "../../i18n";

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: McpDirectoryInfo) => void;
  busy: boolean;
  language: Language;
};

export default function AddMcpModal(props: AddMcpModalProps) {
  const tr = (key: string) => t(key, props.language);

  const [name, setName] = createSignal("");
  const [serverType, setServerType] = createSignal<"remote" | "local">("remote");
  const [url, setUrl] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  const reset = () => {
    setName("");
    setServerType("remote");
    setUrl("");
    setCommand("");
    setError(null);
  };

  const handleClose = () => {
    reset();
    props.onClose();
  };

  const handleSubmit = () => {
    setError(null);

    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(tr("mcp.name_required"));
      return;
    }

    if (serverType() === "remote") {
      const trimmedUrl = url().trim();
      if (!trimmedUrl) {
        setError(tr("mcp.url_or_command_required"));
        return;
      }

      props.onAdd({
        name: trimmedName,
        description: "",
        type: "remote",
        url: trimmedUrl,
        oauth: true,
      });
    } else {
      const trimmedCommand = command().trim();
      if (!trimmedCommand) {
        setError(tr("mcp.url_or_command_required"));
        return;
      }

      props.onAdd({
        name: trimmedName,
        description: "",
        type: "local",
        command: trimmedCommand.split(/\s+/),
        oauth: false,
      });
    }

    handleClose();
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          class="absolute inset-0 bg-gray-1/60 backdrop-blur-sm"
          onClick={handleClose}
        />

        <div class="relative w-full max-w-lg bg-gray-2 border border-gray-6 rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-6">
            <div>
              <h2 class="text-lg font-semibold text-gray-12">
                {tr("mcp.add_modal_title")}
              </h2>
              <p class="text-sm text-gray-11">{tr("mcp.add_modal_subtitle")}</p>
            </div>
            <button
              type="button"
              class="p-2 text-gray-11 hover:text-gray-12 hover:bg-gray-4 rounded-lg transition-colors"
              onClick={handleClose}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div class="px-6 py-5 space-y-4">
            <TextInput
              label={tr("mcp.server_name")}
              placeholder={tr("mcp.server_name_placeholder")}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              autofocus
            />

            <div>
              <div class="mb-1 text-xs font-medium text-dls-secondary">{tr("mcp.server_type")}</div>
              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    serverType() === "remote"
                      ? "bg-dls-active text-dls-text"
                      : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                  }`}
                  onClick={() => setServerType("remote")}
                >
                  {tr("mcp.type_remote")}
                </button>
                <button
                  type="button"
                  class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    serverType() === "local"
                      ? "bg-dls-active text-dls-text"
                      : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                  }`}
                  onClick={() => setServerType("local")}
                >
                  {tr("mcp.type_local_cmd")}
                </button>
              </div>
            </div>

            <Show when={serverType() === "remote"}>
              <TextInput
                label={tr("mcp.server_url")}
                placeholder={tr("mcp.server_url_placeholder")}
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
            </Show>

            <Show when={serverType() === "local"}>
              <TextInput
                label={tr("mcp.server_command")}
                placeholder={tr("mcp.server_command_placeholder")}
                hint={tr("mcp.server_command_hint")}
                value={command()}
                onInput={(e) => setCommand(e.currentTarget.value)}
              />
            </Show>

            <Show when={error()}>
              <div class="rounded-lg bg-red-2 border border-red-6 px-3 py-2 text-xs text-red-11">
                {error()}
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-6 bg-gray-2/50">
            <Button variant="ghost" onClick={handleClose}>
              {tr("mcp.auth.cancel")}
            </Button>
            <Button variant="secondary" onClick={handleSubmit} disabled={props.busy}>
              <Show when={props.busy} fallback={<Plus size={16} />}>
                <Loader2 size={16} class="animate-spin" />
              </Show>
              {tr("mcp.add_server_button")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
