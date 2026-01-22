import { Show, createEffect, createMemo, createSignal } from "solid-js";

import { Globe, X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export default function CreateRemoteWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (input: { baseUrl: string; directory?: string | null; displayName?: string | null }) => void;
  submitting?: boolean;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  const translate = (key: string) => t(key, currentLocale());

  const [baseUrl, setBaseUrl] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? translate("dashboard.create_remote_workspace_title");
  const subtitle = () => props.subtitle ?? translate("dashboard.create_remote_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? translate("dashboard.create_remote_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;

  const canSubmit = createMemo(() => baseUrl().trim().length > 0 && !submitting());

  createEffect(() => {
    if (!props.open) return;
    setBaseUrl("");
    setDirectory("");
    setDisplayName("");
  });

  const content = (
    <div class="bg-gray-2 border border-gray-6 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div class="p-6 border-b border-gray-6 flex justify-between items-center bg-gray-1">
        <div>
          <h3 class="font-semibold text-gray-12 text-lg">{title()}</h3>
          <p class="text-gray-10 text-sm">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class={`hover:bg-gray-4 p-1 rounded-full ${submitting() ? "opacity-50 cursor-not-allowed" : ""}`.trim()}
          >
            <X size={20} class="text-gray-10" />
          </button>
        </Show>
      </div>

      <div class="p-6 flex-1 overflow-y-auto space-y-6">
        <div class="rounded-2xl border border-gray-6 bg-gray-1/40 p-4 flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gray-3 flex items-center justify-center">
            <Globe size={20} class="text-gray-12" />
          </div>
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("dashboard.remote_workspace_title")}</div>
            <div class="text-xs text-gray-10">{translate("dashboard.remote_workspace_hint")}</div>
          </div>
        </div>

        <div class="space-y-4">
          <TextInput
            label={translate("dashboard.remote_base_url_label")}
            placeholder={translate("dashboard.remote_base_url_placeholder")}
            value={baseUrl()}
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
            disabled={submitting()}
          />
          <TextInput
            label={translate("dashboard.remote_directory_label")}
            placeholder={translate("dashboard.remote_directory_placeholder")}
            value={directory()}
            onInput={(event) => setDirectory(event.currentTarget.value)}
            hint={translate("dashboard.remote_directory_hint")}
            disabled={submitting()}
          />
          <TextInput
            label={translate("dashboard.remote_display_name_label")}
            placeholder={translate("dashboard.remote_display_name_placeholder")}
            value={displayName()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
            disabled={submitting()}
          />
        </div>
      </div>

      <div class="p-6 border-t border-gray-6 bg-gray-1 flex justify-end gap-3">
        <Show when={showClose()}>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting()}>
            {translate("common.cancel")}
          </Button>
        </Show>
        <Button
          onClick={() =>
            props.onConfirm({
              baseUrl: baseUrl().trim(),
              directory: directory().trim() ? directory().trim() : null,
              displayName: displayName().trim() ? displayName().trim() : null,
            })
          }
          disabled={!canSubmit()}
          title={!baseUrl().trim() ? translate("dashboard.remote_base_url_required") : undefined}
        >
          {confirmLabel()}
        </Button>
      </div>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div
        class={
          isInline()
            ? "w-full"
            : "fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
