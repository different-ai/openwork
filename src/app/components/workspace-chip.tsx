import type { WorkspaceInfo } from "../lib/tauri";

import { ChevronDown, Folder, Globe, Zap } from "lucide-solid";

function iconForPreset(preset: string) {
  if (preset === "starter") return Zap;
  if (preset === "automation") return Folder;
  if (preset === "minimal") return Globe;
  return Folder;
}

export default function WorkspaceChip(props: {
  workspace: WorkspaceInfo;
  onClick: () => void;
}) {
  const Icon = iconForPreset(props.workspace.preset);

  return (
    <button
      onClick={props.onClick}
      class="flex items-center gap-2 pl-3 pr-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-700 hover:bg-zinc-800 transition-all group"
    >
      <div
        class={`p-1 rounded ${
          props.workspace.preset === "starter"
            ? "bg-amber-500/10 text-amber-500"
            : "bg-indigo-500/10 text-indigo-500"
        }`}
      >
        <Icon size={14} />
      </div>
      <div class="flex flex-col items-start mr-2 min-w-0">
        <span class="text-xs font-medium text-white leading-none mb-0.5 truncate max-w-[9.5rem]">
          {props.workspace.name}
        </span>
        <span class="text-[10px] text-zinc-500 font-mono leading-none max-w-[120px] truncate">
          {props.workspace.path}
        </span>
      </div>
      <ChevronDown size={14} class="text-zinc-500 group-hover:text-zinc-300" />
    </button>
  );
}
