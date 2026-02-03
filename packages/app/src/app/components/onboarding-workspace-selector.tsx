import { For, Show, createEffect, createSignal } from "solid-js";

import { CheckCircle2, FolderPlus, Loader2 } from "lucide-solid";

import Button from "./button";

export default function OnboardingWorkspaceSelector(props: {
  defaultPath: string;
  onConfirm: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
}) {
  const [preset, setPreset] = createSignal<"starter" | "automation" | "minimal">("starter");
  const [selectedFolder, setSelectedFolder] = createSignal(props.defaultPath);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  const options = () => [
    {
      id: "starter" as const,
      name: "Starter workspace",
      desc: "Preconfigured to show you how to use plugins, commands, and skills.",
    },
    {
      id: "minimal" as const,
      name: "Empty workspace",
      desc: "Start with a blank folder and add what you need.",
    },
  ];

  const canContinue = () => Boolean(selectedFolder().trim());

  createEffect(() => {
    if (!selectedFolder().trim()) {
      setSelectedFolder(props.defaultPath);
    }
  });

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

  return (
    <div class="bg-gray-2 border border-gray-6 rounded-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div class="p-6 flex-1 overflow-y-auto space-y-8">
        <div class="space-y-4">
          <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
            <div class="w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs">1</div>
            Select Folder
          </div>
          <div class="ml-9">
            <div
              class={`w-full border border-dashed border-gray-6 bg-gray-1/40 rounded-xl p-4 text-left transition ${
                pickingFolder() ? "opacity-70" : "hover:border-zinc-500"
              }`.trim()}
            >
              <div class="flex items-center gap-3 text-gray-10">
                <FolderPlus size={20} class="text-gray-6" />
                <input
                  class="flex-1 min-w-0 bg-transparent text-sm font-medium text-gray-10 placeholder-gray-600 focus:outline-none"
                  value={selectedFolder()}
                  onInput={(e) => setSelectedFolder(e.currentTarget.value)}
                  placeholder={props.defaultPath}
                />
                <button
                  type="button"
                  onClick={handlePickFolder}
                  disabled={pickingFolder()}
                  class="text-xs text-gray-6 hover:text-gray-10 transition-colors"
                >
                  <Show
                    when={pickingFolder()}
                    fallback={<span>Choose</span>}
                  >
                    <span class="inline-flex items-center gap-2">
                      <Loader2 size={12} class="animate-spin" />
                      Opening...
                    </span>
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
            <div class="w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs">2</div>
            Choose Preset
          </div>
          <div class={`ml-9 grid gap-3 ${!canContinue() ? "opacity-50" : ""}`.trim()}>
            <For each={options()}>
              {(opt) => (
                <div
                  onClick={() => {
                    if (!canContinue()) return;
                    setPreset(opt.id);
                  }}
                  class={`p-4 rounded-xl border cursor-pointer transition-all ${
                    preset() === opt.id
                      ? "bg-gray-4 border-gray-6 hover:border-gray-7"
                      : "bg-gray-1/40 border-gray-6 hover:border-gray-7"
                  } ${!canContinue() ? "pointer-events-none" : ""}`.trim()}
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

    </div>
  );
}
