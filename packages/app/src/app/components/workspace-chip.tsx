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
      class="flex items-center gap-2 pl-3 pr-2 py-1.5 bg-gray-2 border border-gray-6 rounded-lg hover:border-gray-7 hover:bg-gray-4 transition-all group"
    >
      <div
        class={`p-1 rounded ${
          props.workspace.preset === "starter"
            ? "bg-amber-7/10 text-amber-6"
            : "bg-indigo-7/10 text-indigo-6"
        }`}
      >
        <Icon size={14} />
      </div>
      <div class="flex flex-col items-start mr-2 min-w-0">
        <span class="text-xs font-medium text-gray-12 leading-none mb-0.5 truncate max-w-[9.5rem]">
          {props.workspace.name}
        </span>
        <span class="text-[10px] text-gray-10 font-mono leading-none max-w-[120px] truncate">
          {props.workspace.path}
        </span>
      </div>
      <ChevronDown size={14} class="text-gray-10 group-hover:text-gray-11" />
    </button>
  );
}
