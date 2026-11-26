import { cn } from "@/lib/utils";

export type AgentChoice = {
  id: string;
  label: string;
  muted?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function AgentChoices(props: { title?: string; choices: AgentChoice[]; description?: string | null }) {
  return (
    <div data-agent-choices className="w-full max-w-[560px] rounded-2xl border border-dls-border bg-dls-surface px-4 py-3">
      {props.title ? <p className="pb-1 text-[13px] font-medium text-dls-text">{props.title}</p> : null}
      {props.description ? <p className="pb-1 text-xs text-dls-secondary">{props.description}</p> : null}
      <div className="flex flex-col">
        {props.choices.map((choice, index) => (
          <button
            key={choice.id}
            type="button"
            data-agent-choice={choice.id}
            disabled={choice.disabled}
            onClick={choice.onSelect}
            className={cn(
              "group/choice -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-dls-hover focus-visible:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
              choice.muted ? "text-dls-secondary" : "text-dls-text",
            )}
          >
            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dls-border bg-dls-surface text-[11px] font-medium text-dls-secondary group-hover/choice:border-gray-8">
              {String.fromCharCode(65 + index)}
            </span>
            <span className="min-w-0 truncate">{choice.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
