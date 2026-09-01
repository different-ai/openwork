import { useState } from "react";
import {
  coworkerBridge,
  type AvatarColor,
  type AvatarGlasses,
  type CoworkerSummary,
} from "@/lib/bridge";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
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
  const [avatarColor, setAvatarColor] = useState<AvatarColor>("blue");
  const [avatarGlasses, setAvatarGlasses] = useState<AvatarGlasses>("round");
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
          avatarColor,
          avatarGlasses,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-ink/50 p-8">
      <div className="creation-card grid w-full max-w-3xl overflow-hidden rounded-[30px] border border-line md:grid-cols-[290px_1fr]">
        <div className="avatar-stage flex min-h-[370px] flex-col items-center justify-center border-b border-line p-7 md:border-b-0 md:border-r">
          <CoworkerAvatar
            animated
            color={avatarColor}
            glasses={avatarGlasses}
            name={name.trim() || "New coworker"}
            size={152}
          />
          <div className="mt-2 min-w-0 text-center">
            <p className="truncate text-lg font-semibold tracking-[-0.025em] text-snow">
              {name.trim() || "Your coworker"}
            </p>
            <p className="mt-1 text-xs text-mist">A clear identity across your work</p>
          </div>
        </div>

        <div className="p-6 md:p-7">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-spark">New teammate</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em] text-snow">Add a coworker</h1>
            <p className="mt-1 max-w-sm text-sm leading-relaxed text-mist">
              Start with a name and a look. You can teach the job in the first assignment.
            </p>
          </div>

          <div className="mt-6 space-y-4">
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

          <AvatarControls
            color={avatarColor}
            glasses={avatarGlasses}
            onColorChange={setAvatarColor}
            onGlassesChange={setAvatarGlasses}
          />

          <button
            className="text-xs font-medium text-spark hover:underline"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? "Hide optional details" : "Add a role and mission (optional)"}
          </button>

          {showDetails ? (
            <div className="space-y-3 border-t border-line pt-4">
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

          <div className="flex justify-end gap-2 pt-2">
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            ) : null}
            <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? "Adding…" : "Add coworker"}
            </Button>
          </div>
        </div>
          <p className="mt-5 text-[9px] font-medium uppercase tracking-[0.14em] text-mist/70">
            Identity, memory, and workspace stay in inspectable files
          </p>
        </div>
      </div>
    </div>
  );
}
