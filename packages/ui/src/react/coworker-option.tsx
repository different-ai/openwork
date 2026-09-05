/** One lettered choice inside a card: the letter doubles as its keyboard shortcut. */
export function OptionRow({
  letter,
  label,
  description,
  active = false,
  disabled = false,
  tone = "default",
  testId = "interaction-option",
  choice,
  onChoose,
}: {
  letter: string;
  label: string;
  description?: string;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
  testId?: string;
  /** A stable name for what this choice does, for the journeys; the letter is only its position. */
  choice?: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      disabled={disabled}
      data-testid={testId}
      data-letter={letter}
      data-choice={choice}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? "bg-spark/12" : ""
      }`}
      onClick={onChoose}
    >
      <kbd className={`flex size-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold ${active ? "border-spark/50 bg-spark/20 text-spark" : "border-line bg-ink/60 text-mist"}`}>{letter}</kbd>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${tone === "danger" ? "text-rose" : "text-snow"}`}>{label}</span>
        {description ? <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{description}</span> : null}
      </span>
    </button>
  );
}
