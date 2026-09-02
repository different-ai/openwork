import { useState } from "react";
import {
  coworkerBridge,
  type AvatarColor,
  type AvatarGlasses,
  type CoworkerSummary,
  type ProviderSyncRun,
  type RuntimeInfo,
} from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { DEFAULT_PERSONALITY, type Personality } from "@/lib/personalities";
import { PersonalityPicker } from "@/ui/personality-picker";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";
import { RetiredCoworkers } from "@/ui/retired-coworkers";

/**
 * Creation establishes only a durable identity and workspace. The first
 * assignment remains the simplest way to teach a coworker what it should own.
 */
export function NewCoworker({
  runtime,
  session,
  onConnect,
  onSyncProviders,
  onCreated,
  onCancel,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  onConnect: () => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onCreated: (coworker: CoworkerSummary) => void;
  onCancel: (() => void) | null;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [mission, setMission] = useState("");
  const [avatarColor, setAvatarColor] = useState<AvatarColor>("blue");
  const [avatarGlasses, setAvatarGlasses] = useState<AvatarGlasses>("round");
  const [personality, setPersonality] = useState<Personality>(DEFAULT_PERSONALITY);
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CoworkerSummary | null>(null);
  const [modelRuntime, setModelRuntime] = useState(runtime);
  const [selection, setSelection] = useState<ModelSelection>({ model: "", modelVariant: "" });

  async function create() {
    if (!name.trim()) {
      setError("Give your coworker a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const nextCoworker = await coworkerBridge.coworkers.create({
          name: name.trim(),
          role: role.trim(),
          mission: mission.trim(),
          avatarColor,
          avatarGlasses,
          personality,
        });
      setModelRuntime(await coworkerBridge.runtimeInfo());
      setCreated(nextCoworker);
      setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function finish() {
    if (!created) return;
    setBusy(true);
    setError("");
    try {
      const updated = selection.model || selection.modelVariant
        ? await coworkerBridge.coworkers.update(created.slug, selection)
        : created;
      onCreated(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto bg-ink/50 p-8">
        <div className="creation-card grid w-full max-w-3xl overflow-hidden rounded-[30px] border border-line md:grid-cols-[260px_1fr]">
          <div className="avatar-stage flex min-h-[380px] flex-col items-center justify-center border-b border-line p-7 md:border-b-0 md:border-r">
            <CoworkerAvatar animated color={created.avatarColor} glasses={created.avatarGlasses} name={created.name} size={132} />
            <p className="mt-3 text-lg font-semibold tracking-[-0.025em] text-snow">{created.name}</p>
            <p className="mt-1 text-center text-xs text-mist">Identity and workspace ready</p>
          </div>
          <div className="p-6 md:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-spark">How {created.name} works</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em] text-snow">Choose a model</h1>
            <p className="mt-1 text-sm leading-relaxed text-mist">
              {session
                ? "Your organization's OpenWork models are listed first, followed by providers configured on this Mac. You can change this later."
                : "Choose from providers connected on this Mac, or follow the engine default. You can change this later."}
            </p>
            <div className="mt-5">
              <ModelPicker
                runtime={modelRuntime}
                session={session}
                coworker={created}
                value={selection.model}
                modelVariant={selection.modelVariant}
                onChange={setSelection}
                onSyncProviders={onSyncProviders}
                onConnect={onConnect}
              />
            </div>
            {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
            <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-[10px] uppercase tracking-[0.12em] text-mist/75">Step 2 of 2</p>
              <Button aria-busy={busy} variant="primary" disabled={busy} onClick={() => void finish()}>
                {busy ? "Finishing…" : "Finish setup"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto bg-ink/50 p-8">
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

          <PersonalityPicker value={personality} seed={name.trim() || "coworker"} onChange={setPersonality} />

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
            <Button aria-busy={busy} variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? "Adding…" : "Add coworker"}
            </Button>
          </div>
        </div>
          <p className="mt-5 text-[9px] font-medium uppercase tracking-[0.14em] text-mist/70">
            Identity, memory, and workspace stay in inspectable files
          </p>
        </div>
      </div>
      <RetiredCoworkers onRestored={onCreated} />
    </div>
  );
}
