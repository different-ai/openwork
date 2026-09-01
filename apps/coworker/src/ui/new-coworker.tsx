import { useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";

/**
 * Creating a coworker is intentionally lightweight (§44 of the product brief):
 * files + workspace registration; every other capability is already there.
 */
export function NewCoworker({ onCreated, onCancel }: { onCreated: (coworker: CoworkerSummary) => void; onCancel: (() => void) | null }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [mission, setMission] = useState("");
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
      onCreated(await coworkerBridge.coworkers.create({ name: name.trim(), role: role.trim(), mission: mission.trim() }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-8">
        <h1 className="mb-1 text-xl font-semibold text-snow">New coworker</h1>
        <p className="mb-6 text-sm text-mist">
          A coworker is a persistent teammate: it keeps its identity, memory, and workspace in plain
          files you can always inspect.
        </p>
        <div className="space-y-4">
          <Field label="Name">
            <input className={inputClass} value={name} placeholder="Research Coworker" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Role (one line)">
            <input
              className={inputClass}
              value={role}
              placeholder="Tracks the competitive landscape"
              onChange={(event) => setRole(event.target.value)}
            />
          </Field>
          <Field label="Mission">
            <textarea
              className={`${inputClass} min-h-24 resize-y`}
              value={mission}
              placeholder="What should this coworker own over time?"
              onChange={(event) => setMission(event.target.value)}
            />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex justify-end gap-2">
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              {busy ? "Creating…" : "Create coworker"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
