import { For, Show, createSignal } from "solid-js";

import { CheckCircle2, FolderPlus, X } from "lucide-solid";

import Button from "./Button";

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: "starter" | "automation" | "minimal") => void;
}) {
  const [preset, setPreset] = createSignal<"starter" | "automation" | "minimal">("starter");

  const options = () => [
    {
      id: "starter" as const,
      name: "Starter",
      desc: "Pre-configured with Scheduler & starter templates. Best for general use.",
    },
    {
      id: "automation" as const,
      name: "Automation",
      desc: "Optimized for scheduled/background work.",
    },
    {
      id: "minimal" as const,
      name: "Minimal",
      desc: "Empty project. Adds only core config.",
    },
  ];

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div class="bg-zinc-900 border border-zinc-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="p-6 border-b border-zinc-800 flex justify-between items-center bg-zinc-950">
            <div>
              <h3 class="font-semibold text-white text-lg">Create Workspace</h3>
              <p class="text-zinc-500 text-sm">Initialize a new folder-based workspace.</p>
            </div>
            <button onClick={props.onClose} class="hover:bg-zinc-800 p-1 rounded-full">
              <X size={20} class="text-zinc-500" />
            </button>
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
                <div class="w-full border border-dashed border-zinc-700 bg-zinc-900/50 rounded-xl p-4 text-left">
                  <div class="flex items-center gap-3 text-zinc-400">
                    <FolderPlus size={20} />
                    <span class="text-sm">You will choose a directory next.</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-white">
                <div class="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs">
                  2
                </div>
                Choose Preset
              </div>
              <div class="ml-9 grid gap-3">
                <For each={options()}>
                  {(opt) => (
                    <div
                      onClick={() => setPreset(opt.id)}
                      class={`p-4 rounded-xl border cursor-pointer transition-all ${
                        preset() === opt.id
                          ? "bg-indigo-500/10 border-indigo-500/50"
                          : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                      }`}
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
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button onClick={() => props.onConfirm(preset())}>Create Workspace</Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
