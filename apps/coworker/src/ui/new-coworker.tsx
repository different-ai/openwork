import { useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";

/**
 * Creation establishes only a durable identity and workspace. The first
 * assignment remains the simplest way to teach a coworker what it should own.
 */
export function NewCoworker({
  onCreated,
  onCancel,
}: {
  onCreated: (coworker: CoworkerSummary) => void;
  onCancel: (() => void) | null;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [mission, setMission] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim()) {
      setError("Give your coworker a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onCreated(
        await coworkerBridge.coworkers.create({
          name: name.trim(),
          role: role.trim(),
          mission: mission.trim(),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-ink p-8">
      <div className="w-full max-w-md">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-panel text-xl font-semibold text-snow ring-1 ring-line">
          {name.trim().slice(0, 1).toUpperCase() || "C"}
        </span>
        <div className="mt-5 text-center">
          <h1 className="text-xl font-semibold text-snow">Add a coworker</h1>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-mist">
            Start with a name. You can explain the job in the first assignment and refine it later.
          </p>
        </div>

        <div className="mt-6 space-y-3 rounded-2xl border border-line bg-panel/60 p-4">
          <Field label="Name">
            <input
              autoFocus
              className={`${inputClass} bg-ink`}
              value={name}
              placeholder="Scout"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !showDetails) void create();
              }}
            />
          </Field>

          <button
            className="text-xs font-medium text-spark hover:underline"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? "Hide optional details" : "Add a role and mission (optional)"}
          </button>

          {showDetails ? (
            <div className="space-y-3 border-t border-line pt-3">
              <Field label="Role">
                <input
                  className={`${inputClass} bg-ink`}
                  value={role}
                  placeholder="Research partner"
                  onChange={(event) => setRole(event.target.value)}
                />
              </Field>
              <Field label="Mission">
                <textarea
                  className={`${inputClass} min-h-24 resize-y bg-ink`}
                  value={mission}
                  placeholder="What should this coworker own over time?"
                  onChange={(event) => setMission(event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex justify-end gap-2 pt-1">
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            ) : null}
            <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? "Adding…" : "Add coworker"}
            </Button>
          </div>
        </div>

        <p className="mt-4 text-center text-[10px] font-medium uppercase tracking-[0.12em] text-mist">
          Identity, memory, and workspace stay in inspectable files
        </p>
      </div>
    </div>
  );
}
