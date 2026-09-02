import { PERSONALITY_OPTIONS, previewSayings, type Personality } from "@/lib/personalities";
import { Field, inputClass } from "@/ui/kit";

/**
 * Choose the coworker's voice for the working state. The preview shows the
 * first sayings this coworker would actually use, so the choice is concrete.
 * "None" keeps plain status text everywhere.
 */
export function PersonalityPicker({
  value,
  seed,
  onChange,
  label = "Personality",
}: {
  value: Personality;
  /** Usually the coworker's name or slug; drives the preview order. */
  seed: string;
  onChange: (personality: Personality) => void;
  label?: string;
}) {
  const option = PERSONALITY_OPTIONS.find((candidate) => candidate.id === value) ?? PERSONALITY_OPTIONS[1]!;
  const preview = previewSayings(value, seed || "coworker", 3);
  return (
    <div className="space-y-2">
      <Field label={label}>
        <select
          className={`${inputClass} bg-panel`}
          value={value}
          data-testid="coworker-personality"
          onChange={(event) => {
            const next = PERSONALITY_OPTIONS.find((candidate) => candidate.id === event.target.value);
            if (next) onChange(next.id);
          }}
        >
          {PERSONALITY_OPTIONS.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[11px] leading-relaxed text-mist">
        {option.description}
        {value !== "none" ? " Only the wording while working changes." : ""}
      </p>
      {preview.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Example sayings">
          {preview.map((saying) => (
            <li key={saying} className="rounded-full border border-line bg-ink px-2.5 py-1 text-[11px] text-snow/85">
              {saying}…
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-mist/80">While working, the app shows “Working…” and nothing more.</p>
      )}
    </div>
  );
}
