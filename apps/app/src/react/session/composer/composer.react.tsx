/** @jsxImportSource react */
import { LexicalPromptEditor } from "./editor.react";

type ComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  busy: boolean;
  disabled: boolean;
  statusLabel: string;
};

export function ReactSessionComposer(props: ComposerProps) {
  return (
    <div className="mx-auto w-full max-w-[800px] px-4">
      <div className="rounded-[28px] border border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]">
        <LexicalPromptEditor
          value={props.draft}
          disabled={props.disabled}
          placeholder="Describe your task..."
          onChange={props.onDraftChange}
          onSubmit={props.onSend}
        />
        <div className="flex items-center justify-between gap-3 border-t border-dls-border px-4 py-3">
          <div className="text-xs text-dls-secondary">{props.statusLabel}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-dls-border px-4 py-2 text-sm text-dls-secondary transition-colors hover:bg-dls-hover disabled:opacity-50"
              onClick={props.onStop}
              disabled={!props.busy}
            >
              Stop
            </button>
            <button
              type="button"
              className="rounded-full bg-[var(--dls-accent)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:opacity-50"
              onClick={props.onSend}
              disabled={props.busy || props.disabled || !props.draft.trim()}
            >
              Run task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
