import { useEffect, useMemo, useState } from "react";
import { coworkerBridge, type CoworkerGroupSummary, type CoworkerSummary } from "@/lib/bridge";
import { suggestGroupName } from "@/lib/groups";
import { acknowledgeCoworker, CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ErrorNote } from "@/ui/kit";

/**
 * Start a group chat: pick at least two coworkers, keep or change the suggested
 * name, and create. The sheet sits over the conversation column and closes on
 * Escape or Cancel.
 */
export function NewGroupSheet({
  coworkers,
  onCreated,
  onCancel,
}: {
  coworkers: CoworkerSummary[];
  onCreated: (group: CoworkerGroupSummary) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => coworkers.slice(0, 2).map((coworker) => coworker.slug));
  const [nameEdited, setNameEdited] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const members = useMemo(() => coworkers.filter((coworker) => selected.includes(coworker.slug)), [coworkers, selected]);
  const suggested = useMemo(() => suggestGroupName(members), [members]);
  const shownName = nameEdited ? name : suggested;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function toggle(slug: string): void {
    setSelected((current) => (current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]));
  }

  async function create(): Promise<void> {
    if (members.length < 2 || busy) return;
    setBusy(true);
    setError("");
    try {
      const group = await coworkerBridge.groups.create({ name: shownName.trim() || suggested, participantSlugs: members.map((member) => member.slug) });
      for (const slug of group.participantSlugs) acknowledgeCoworker(slug, "wake");
      onCreated(group);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-group-title"
        data-testid="new-group-sheet"
        className="w-full max-w-md rounded-2xl border border-line bg-ink/95 p-5 shadow-2xl backdrop-blur"
      >
        <h2 id="new-group-title" className="text-base font-semibold text-snow">New group chat</h2>
        <p className="mt-1 text-xs text-mist">Choose who is in the room. One coworker answers each message unless you name others.</p>
        <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">To</p>
        <ul className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto" aria-label="Coworkers to include">
          {coworkers.map((coworker) => {
            const checked = selected.includes(coworker.slug);
            return (
              <li key={coworker.slug}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  data-testid="new-group-member"
                  data-slug={coworker.slug}
                  onClick={() => toggle(coworker.slug)}
                  className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-panel ${checked ? "bg-panel/70" : ""}`}
                >
                  <CoworkerAvatar identity={coworker.slug} motion="quiet" gaze={false} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-snow">{coworker.name}</span>
                    {coworker.role ? <span className="block truncate text-[11px] text-mist">{coworker.role}</span> : null}
                  </span>
                  <span aria-hidden="true" className={`flex size-4 items-center justify-center rounded-full border text-[10px] ${checked ? "border-spark bg-spark text-ink" : "border-line text-transparent"}`}>✓</span>
                </button>
              </li>
            );
          })}
        </ul>
        <label className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.14em] text-mist" htmlFor="new-group-name">Name</label>
        <input
          id="new-group-name"
          data-testid="new-group-name"
          className="mt-1.5 h-9 w-full rounded-xl border border-line bg-black/18 px-3 text-sm text-snow outline-none focus:border-spark/50"
          value={shownName}
          onChange={(event) => {
            setNameEdited(true);
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={members.length < 2 || busy}>
            {busy ? "Creating…" : "Create group chat"}
          </Button>
        </div>
      </section>
    </div>
  );
}
