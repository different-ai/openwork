import { For, Show, createSignal } from "solid-js";

import { CheckCircle2, FolderPlus, Loader2, X } from "lucide-solid";

import Button from "./button";

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  const [preset, setPreset] = createSignal<"starter" | "automation" | "minimal">("starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  const options = () => [
    {
      id: "starter" as const,
      name: "Starter workspace",
      desc: "Preconfigured to show you how to use plugins, templates, and skills.",
    },
    {
      id: "minimal" as const,
      name: "Empty workspace",
      desc: "Start with a blank folder and add what you need.",
    },
  ];

  const folderLabel = () => {
    const folder = selectedFolder();
    if (!folder) return "Choose a folder";
    const parts = folder.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? folder;
  };

  const folderSubLabel = () => {
    const folder = selectedFolder();
    if (!folder) return "You will choose a directory next.";
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
  const title = () => props.title ?? "Create Workspace";
  const subtitle = () => props.subtitle ?? "Initialize a new folder-based workspace.";
  const confirmLabel = () => props.confirmLabel ?? "Create Workspace";
  const isInline = () => props.inline ?? false;

  const content = (
    <div class="bg-zinc-900 border border-zinc-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div class="p-6 border-b border-zinc-800 flex justify-between items-center bg-zinc-950">
        <div>
          <h3 class="font-semibold text-white text-lg">{title()}</h3>
          <p class="text-zinc-500 text-sm">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button onClick={props.onClose} class="hover:bg-zinc-800 p-1 rounded-full">
            <X size={20} class="text-zinc-500" />
          </button>
        </Show>
      </div>

          <div class="p-6 flex-1 overflow-y-auto space-y-8">
            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-white">
                <div class="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs">
                  1
                </div>
                Select Folder
              </div>
              <div class="ml-9">
                <button
                  type="button"
                  onClick={handlePickFolder}
                  disabled={pickingFolder()}
                  class={`w-full border border-dashed border-zinc-700 bg-zinc-900/50 rounded-xl p-4 text-left transition ${
                    pickingFolder() ? "opacity-70 cursor-wait" : "hover:border-zinc-500"
                  }`.trim()}
                >
                  <div class="flex items-center gap-3 text-zinc-200">
                    <FolderPlus size={20} class="text-zinc-400" />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-zinc-100 truncate">{folderLabel()}</div>
                      <div class="text-xs text-zinc-500 font-mono truncate mt-1">{folderSubLabel()}</div>
                    </div>
                    <Show
                      when={pickingFolder()}
                      fallback={<span class="text-xs text-zinc-500">Change</span>}
                    >
                      <span class="flex items-center gap-2 text-xs text-zinc-500">
                        <Loader2 size={12} class="animate-spin" />
                        Opening...
                      </span>
                    </Show>
                  </div>
                </button>
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-white">
                <div class="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs">
                  2
                </div>
                Choose Preset
              </div>
              <div class={`ml-9 grid gap-3 ${!selectedFolder() ? "opacity-50" : ""}`.trim()}>
                <For each={options()}>
                  {(opt) => (
                    <div
                      onClick={() => {
                        if (!selectedFolder()) return;
                        setPreset(opt.id);
                      }}
                      class={`p-4 rounded-xl border cursor-pointer transition-all ${
                        preset() === opt.id
                          ? "bg-indigo-500/10 border-indigo-500/50"
                          : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                      } ${!selectedFolder() ? "pointer-events-none" : ""}`.trim()}
                    >
                      <div class="flex justify-between items-start">
                        <div>
                          <div
                            class={`font-medium text-sm ${
                              preset() === opt.id ? "text-indigo-400" : "text-zinc-200"
                            }`}
                          >
                            {opt.name}
                          </div>
                          <div class="text-xs text-zinc-500 mt-1">{opt.desc}</div>
                        </div>
                        <Show when={preset() === opt.id}>
                          <CheckCircle2 size={16} class="text-indigo-500" />
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>

      <div class="p-6 border-t border-zinc-800 bg-zinc-950 flex justify-end gap-3">
        <Show when={showClose()}>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
        </Show>
        <Button
          onClick={() => props.onConfirm(preset(), selectedFolder())}
          disabled={!selectedFolder()}
          title={!selectedFolder() ? "Choose a folder to continue." : undefined}
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
            : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
