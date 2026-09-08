import { useEffect, useMemo, useState } from "react";
import { coworkerBridge, type CoworkerGroupSummary, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import { liveGroupRun } from "@/lib/group-runs";
import { createCoworkerThreads, type EngineModelOption } from "@/lib/threads";
import { acknowledgeCoworker, CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ErrorNote } from "@/ui/kit";

/**
 * A group's details as flat rows: its name, who is in it (changes apply to the
 * next message; a coworker mid-reply finishes), the facilitator's AI model
 * under Advanced, and a quiet Archive row. Escape or the backdrop closes it.
 */
export function GroupDetailsSheet({
  group,
  coworkers,
  runtime,
  onClose,
  onChanged,
  onArchived,
  managed = false,
}: {
  managed?: boolean;
  group: CoworkerGroupSummary;
  coworkers: CoworkerSummary[];
  runtime: RuntimeInfo;
  onClose: () => void;
  onChanged: (group: CoworkerGroupSummary) => void;
  onArchived: (group: CoworkerGroupSummary) => void;
}) {
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState<string[]>(group.participantSlugs);
  const [models, setModels] = useState<EngineModelOption[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const live = Boolean(liveGroupRun(group.id));
  const membersChanged = useMemo(
    () => selected.length !== group.participantSlugs.length || selected.some((slug) => !group.participantSlugs.includes(slug)),
    [group.participantSlugs, selected],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The connected models come from any registered workspace; the first member with one will do.
  useEffect(() => {
    const anchor = coworkers.find((coworker) => group.participantSlugs.includes(coworker.slug) && coworker.workspaceId);
    if (!anchor || !runtime.engineManaged) {
      setModels([]);
      return;
    }
    let cancelled = false;
    void createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: anchor.workspaceId, token: runtime.ownerToken })
      .listModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [coworkers, group.participantSlugs, runtime]);

  async function save(patch: Parameters<typeof coworkerBridge.groups.update>[1], label: string): Promise<void> {
    setBusy(label);
    setError("");
    try {
      const updated = await coworkerBridge.groups.update(group.id, patch);
      if (patch.participantSlugs) {
        for (const slug of updated.participantSlugs) {
          if (!group.participantSlugs.includes(slug)) acknowledgeCoworker(slug, "wake");
        }
      }
      onChanged(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  function toggle(slug: string): void {
    setSelected((current) => (current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]));
  }

  const rowClass = "flex items-center justify-between gap-4 py-3";
  const labelClass = "text-[10px] font-semibold uppercase tracking-[0.14em] text-mist";

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-details-title"
        data-testid="group-details-sheet"
        className="w-full max-w-md rounded-2xl border border-line bg-ink/95 p-5 shadow-2xl backdrop-blur"
      >
        <h2 id="group-details-title" className="text-base font-semibold text-snow">Group details</h2>
        <div className="mt-3 divide-y divide-line/70">
          <div className={rowClass}>
            <label className={labelClass} htmlFor="group-details-name">Name</label>
            <input
              disabled={managed}
              id="group-details-name"
              data-testid="group-details-name"
              className="h-8 w-60 rounded-lg border border-line bg-black/18 px-2 text-sm text-snow outline-none focus:border-spark/50"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                if (name.trim() && name.trim() !== group.name) void save({ name: name.trim() }, "name");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim() && name.trim() !== group.name) void save({ name: name.trim() }, "name");
              }}
            />
          </div>
          <div className="py-3">
            <div className="flex items-center justify-between gap-4">
              <p className={labelClass}>Members</p>
              <p className="text-[11px] text-mist">Changes apply to the next message</p>
            </div>
            <ul className="mt-2 divide-y divide-line/50" aria-label="Members">
              {coworkers.map((coworker) => {
                const checked = selected.includes(coworker.slug);
                return (
                  <li key={coworker.slug}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      data-testid="group-details-member"
                      data-slug={coworker.slug}
                      onClick={() => toggle(coworker.slug)}
                      className="flex w-full items-center gap-3 py-2 text-left"
                    >
                      <CoworkerAvatar identity={coworker.slug} motion="quiet" gaze={false} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={24} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-snow">{coworker.name}</span>
                        <span className="block truncate text-[11px] text-mist">{coworker.role || "No role yet"}</span>
                      </span>
                      <span aria-hidden="true" className={`flex size-4 items-center justify-center rounded-full border text-[10px] ${checked ? "border-spark bg-spark text-ink" : "border-line text-transparent"}`}>✓</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {membersChanged ? (
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => setSelected(group.participantSlugs)}>Undo</Button>
                <Button variant="primary" disabled={selected.length < 2 || busy === "members"} onClick={() => void save({ participantSlugs: selected }, "members")} data-testid="group-details-save-members">
                  {selected.length < 2 ? "Keep at least two" : busy === "members" ? "Saving…" : "Save members"}
                </Button>
              </div>
            ) : null}
          </div>
          <details className="py-3" data-testid="group-details-advanced">
            <summary className={`${labelClass} cursor-pointer list-none`}>Advanced</summary>
            <div className={`${rowClass} pb-0`}>
              <label className="text-sm text-snow" htmlFor="group-facilitator-model">
                Who-answers AI model
                <span className="block text-[11px] text-mist">Chooses who replies; never speaks in the chat</span>
              </label>
              <select
                id="group-facilitator-model"
                data-testid="group-facilitator-model"
                className="h-8 max-w-56 rounded-lg border border-line bg-black/18 px-2 text-xs text-snow outline-none focus:border-spark/50"
                value={group.facilitatorModel}
                disabled={busy === "model"}
                onChange={(event) => void save({ facilitatorModel: event.target.value }, "model")}
              >
                <option value="">Automatic (the model your coworkers use)</option>
                {(models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
            </div>
          </details>
          {!managed ? <div className={rowClass}>
            <p className="text-sm text-snow">
              Archive this group chat
              <span className="block text-[11px] text-mist">Its messages are kept; it leaves the rail</span>
            </p>
            <Button variant="ghost" className="text-rose" disabled={live || busy === "archive"} title={live ? "Wait for the current reply to finish" : undefined} data-testid="group-details-archive" onClick={() => {
              setBusy("archive");
              void coworkerBridge.groups.archive(group.id).then(onArchived).catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setBusy("");
              });
            }}>
              Archive
            </Button>
          </div> : <p className="py-3 text-xs text-mist">Turn All Hands off in Settings to hide this space. Your conversation is kept.</p>}
        </div>
        {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </section>
    </div>
  );
}
