import { Show } from "solid-js";
import { FileText, Trash2, X } from "lucide-solid";

import LiveMarkdownEditor from "../live-markdown-editor";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onClose?: () => void;
  onClear?: () => void;
  title?: string;
};

export default function ScratchpadPanel(props: Props) {
  const title = () => props.title ?? "Notes";
  const canClear = () => typeof props.onClear === "function";

  return (
    <div class="flex flex-col h-full min-h-0">
      <div class="h-14 px-4 border-b border-dls-border flex items-center justify-between bg-dls-sidebar">
        <div class="flex items-center gap-2 min-w-0">
          <FileText size={16} class="text-dls-secondary shrink-0" />
          <div class="text-sm font-semibold text-dls-text truncate">{title()}</div>
        </div>
        <div class="flex items-center gap-1.5">
          <Show when={canClear()}>
            <button
              type="button"
              class="p-2 rounded-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
              onClick={() => props.onClear?.()}
              title="Clear notes"
              aria-label="Clear notes"
            >
              <Trash2 size={16} />
            </button>
          </Show>
          <Show when={typeof props.onClose === "function"}>
            <button
              type="button"
              class="p-2 rounded-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
              onClick={() => props.onClose?.()}
              title="Close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-hidden">
        <LiveMarkdownEditor
          value={props.value}
          onChange={props.onChange}
          placeholder="# Write notes like Obsidian\n\n- Use # headings\n- Use *italic* and **bold**\n"
          ariaLabel="Scratchpad"
          class="h-full"
        />
      </div>
    </div>
  );
}
