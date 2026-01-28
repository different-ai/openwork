import { Show, createEffect, createMemo, createSignal } from "solid-js";

import { Globe, X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export default function CreateRemoteWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    opencodeBaseUrl?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => void;
  submitting?: boolean;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  let inputRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const [remoteType, setRemoteType] = createSignal<"openwork" | "opencode">("opencode");
  const [openworkHostUrl, setOpenworkHostUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [opencodeBaseUrl, setOpencodeBaseUrl] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? translate("dashboard.create_remote_workspace_title");
  const subtitle = () => props.subtitle ?? translate("dashboard.create_remote_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? translate("dashboard.create_remote_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;

  const canSubmit = createMemo(() => {
    if (submitting()) return false;
    if (remoteType() === "openwork") return openworkHostUrl().trim().length > 0;
    return opencodeBaseUrl().trim().length > 0;
  });

  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => inputRef?.focus());
    }
  });

  createEffect(() => {
    if (!props.open) return;
    setRemoteType("opencode");
    setOpenworkHostUrl("");
    setOpenworkToken("");
    setOpenworkTokenVisible(false);
    setOpencodeBaseUrl("");
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
          <div class="grid grid-cols-2 gap-2 rounded-xl border border-gray-6 bg-gray-1/60 p-1">
            <button
              type="button"
              onClick={() => setRemoteType("openwork")}
              class={`text-xs px-3 py-2 rounded-lg transition-colors ${
                remoteType() === "openwork"
                  ? "bg-gray-12/10 text-gray-12"
                  : "text-gray-10 hover:text-gray-12"
              }`}
            >
              {translate("dashboard.remote_mode_openwork_alpha")}
            </button>
            <button
              type="button"
              onClick={() => setRemoteType("opencode")}
              class={`text-xs px-3 py-2 rounded-lg transition-colors ${
                remoteType() === "opencode"
                  ? "bg-gray-12/10 text-gray-12"
                  : "text-gray-10 hover:text-gray-12"
              }`}
            >
              {translate("dashboard.remote_mode_direct")}
            </button>
          </div>

          <Show when={remoteType() === "openwork"}>
            <div class="space-y-4">
              <TextInput
                ref={inputRef}
                label={translate("dashboard.openwork_host_label")}
                placeholder={translate("dashboard.openwork_host_placeholder")}
                value={openworkHostUrl()}
                onInput={(event) => setOpenworkHostUrl(event.currentTarget.value)}
                hint={translate("dashboard.openwork_host_hint")}
                disabled={submitting()}
              />

              <label class="block">
                <div class="mb-1 text-xs font-medium text-gray-11">{translate("dashboard.openwork_host_token_label")}</div>
                <div class="flex items-center gap-2">
                  <input
                    type={openworkTokenVisible() ? "text" : "password"}
                    value={openworkToken()}
                    onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                    placeholder={translate("dashboard.openwork_host_token_placeholder")}
                    disabled={submitting()}
                    class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                  />
                  <Button
                    variant="outline"
                    class="text-xs h-9 px-3 shrink-0"
                    onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                    disabled={submitting()}
                  >
                    {openworkTokenVisible() ? translate("common.hide") : translate("common.show")}
                  </Button>
                </div>
                <div class="mt-1 text-xs text-gray-10">{translate("dashboard.openwork_host_token_hint")}</div>
              </label>
            </div>
          </Show>

          <Show when={remoteType() === "opencode"}>
            <TextInput
              ref={inputRef}
              label={translate("dashboard.remote_base_url_label")}
              placeholder={translate("dashboard.remote_base_url_placeholder")}
              value={opencodeBaseUrl()}
              onInput={(event) => setOpencodeBaseUrl(event.currentTarget.value)}
              disabled={submitting()}
            />
          </Show>

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
              openworkHostUrl: remoteType() === "openwork" ? openworkHostUrl().trim() : null,
              openworkToken: remoteType() === "openwork" ? openworkToken().trim() : null,
              opencodeBaseUrl: remoteType() === "opencode" ? opencodeBaseUrl().trim() : null,
              directory: directory().trim() ? directory().trim() : null,
              displayName: displayName().trim() ? displayName().trim() : null,
            })
          }
          disabled={!canSubmit()}
          title={
            remoteType() === "openwork"
              ? !openworkHostUrl().trim()
                ? translate("dashboard.remote_base_url_required")
                : undefined
              : !opencodeBaseUrl().trim()
                ? translate("dashboard.remote_base_url_required")
                : undefined
          }
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
