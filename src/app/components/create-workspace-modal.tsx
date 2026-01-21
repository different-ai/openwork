import { For, Show, createSignal } from "solid-js";

import { CheckCircle2, FolderPlus, Loader2, X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
  submitting?: boolean;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  const translate = (key: string) => t(key, currentLocale());

  const [preset, setPreset] = createSignal<"starter" | "automation" | "minimal">("starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  const options = () => [
    {
      id: "starter" as const,
      name: translate("dashboard.starter_workspace"),
      desc: translate("dashboard.starter_workspace_desc"),
    },
    {
      id: "minimal" as const,
      name: translate("dashboard.empty_workspace"),
      desc: translate("dashboard.empty_workspace_desc"),
    },
  ];

  const folderLabel = () => {
    const folder = selectedFolder();
    if (!folder) return translate("dashboard.choose_folder");
    const parts = folder.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? folder;
  };

  const folderSubLabel = () => {
    const folder = selectedFolder();
    if (!folder) return translate("dashboard.choose_folder_next");
    return folder;
  };

  const handlePickFolder = async () => {
    if (pickingFolder()) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const next = await props.onPickFolder();
      if (next) {
        setSelectedFolder(next);
      }
    } finally {
      setPickingFolder(false);
    }
  };

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? translate("dashboard.create_workspace_title");
  const subtitle = () => props.subtitle ?? translate("dashboard.create_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? translate("dashboard.create_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;

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

          <div class="p-6 flex-1 overflow-y-auto space-y-8">
            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
                <div class="w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs">
                  1
                </div>
                {translate("dashboard.select_folder")}
              </div>
              <div class="ml-9">
                <button
                  type="button"
                  onClick={handlePickFolder}
                  disabled={pickingFolder() || submitting()}
                  class={`w-full border border-dashed border-gray-7 bg-gray-2/50 rounded-xl p-4 text-left transition ${
                    pickingFolder() ? "opacity-70 cursor-wait" : "hover:border-gray-7"
                  }`.trim()}
                >
                  <div class="flex items-center gap-3 text-gray-12">
                    <FolderPlus size={20} class="text-gray-11" />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-gray-12 truncate">{folderLabel()}</div>
                      <div class="text-xs text-gray-10 font-mono truncate mt-1">{folderSubLabel()}</div>
                    </div>
                    <Show
                      when={pickingFolder()}
                      fallback={<span class="text-xs text-gray-10">{translate("dashboard.change")}</span>}
                    >
                      <span class="flex items-center gap-2 text-xs text-gray-10">
                        <Loader2 size={12} class="animate-spin" />
                        {translate("dashboard.opening")}
                      </span>
                    </Show>
                  </div>
                </button>
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
                <div class="w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs">
                  2
                </div>
                {translate("dashboard.choose_preset")}
              </div>
              <div class={`ml-9 grid gap-3 ${!selectedFolder() ? "opacity-50" : ""}`.trim()}>
                <For each={options()}>
                  {(opt) => (
                    <div
                      onClick={() => {
                        if (!selectedFolder()) return;
                        if (submitting()) return;
                        setPreset(opt.id);
                      }}
                      class={`p-4 rounded-xl border cursor-pointer transition-all ${
                        preset() === opt.id
                          ? "bg-indigo-7/10 border-indigo-7/50"
                          : "bg-gray-2 border-gray-6 hover:border-gray-7"
                      } ${!selectedFolder() || submitting() ? "pointer-events-none" : ""}`.trim()}
                    >
                      <div class="flex justify-between items-start">
                        <div>
                          <div
                            class={`font-medium text-sm ${
                              preset() === opt.id ? "text-indigo-11" : "text-gray-12"
                            }`}
                          >
                            {opt.name}
                          </div>
                          <div class="text-xs text-gray-10 mt-1">{opt.desc}</div>
                        </div>
                        <Show when={preset() === opt.id}>
                          <CheckCircle2 size={16} class="text-indigo-6" />
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>

      <div class="p-6 border-t border-gray-6 bg-gray-1 flex justify-end gap-3">
        <Show when={showClose()}>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting()}>
              {translate("common.cancel")}
          </Button>
        </Show>
        <Button
          onClick={() => props.onConfirm(preset(), selectedFolder())}
          disabled={!selectedFolder() || submitting()}
          title={!selectedFolder() ? translate("dashboard.choose_folder_continue") : undefined}
        >
          <Show
            when={submitting()}
            fallback={confirmLabel()}
          >
            <span class="inline-flex items-center gap-2">
              <Loader2 size={16} class="animate-spin" />
              Creating...
            </span>
          </Show>
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
