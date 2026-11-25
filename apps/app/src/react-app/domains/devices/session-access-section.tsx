/** @jsxImportSource react */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteSessionAccessState } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { LayoutSection, LayoutSectionHeader, LayoutSectionTitle } from "../settings/settings-layout";

export const sessionAccessQueryKey = ["desktop", "remote-session-access"] as const;
const SESSION_ACCESS_REFRESH_MS = 5_000;
const HEADING = "What other devices can do on this computer";
const NOT_CONNECTED = "Available once this computer is connected to your organization.";

const CHOICES: ReadonlyArray<{ mode: RemoteSessionAccessMode; title: string; description: string }> = [
  { mode: "off", title: "Nothing", description: "Your other devices, Workbot and agents can't start or reach anything on this computer." },
  { mode: "created", title: "Start tasks here", description: "Your other devices, Workbot and agents working for you can start tasks here and follow, continue and answer the ones they started." },
  { mode: "all", title: "Also open sessions I started here", description: "They can also open sessions you started on this computer, continue them, stop them and answer their questions and permission requests." },
];

export function lockedReason(mode: RemoteSessionAccessMode, state: RemoteSessionAccessState): string | null {
  if (!state.connected) return NOT_CONNECTED;
  if (mode === "off") return null;
  if (state.ceiling === "off") return "Your organization has turned this off.";
  if (mode === "created") return null;
  if (!state.supported) return "Sign in again or update OpenWork to use this.";
  if (state.ceiling === null) return NOT_CONNECTED;
  if (state.ceiling === "created") return "Your organization only allows tasks started remotely.";
  return null;
}

function unchosenNote(state: RemoteSessionAccessState): string | null {
  if (!state.connected || state.mode !== null) return null;
  if (state.optIn) return "You haven't allowed this computer yet, so nothing reaches it.";
  return state.effective === "created" ? "You haven't chosen. Tasks started from your other devices are allowed, as before." : null;
}

function describeChoices(state: RemoteSessionAccessState) {
  let written: string | null = null;
  return CHOICES.map(choice => {
    const reason = lockedReason(choice.mode, state);
    const stored = state.mode === choice.mode;
    const note = reason === null ? null : stored ? `Not in effect. ${reason}` : reason === written ? null : reason;
    if (note !== null) written = reason;
    return { ...choice, locked: reason !== null, note };
  });
}

export function SessionAccessSection() {
  const bridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__?.remoteSessionAccess;
  if (!bridge?.get || !bridge.set) return null;
  return <SessionAccessChoices read={bridge.get} write={bridge.set} />;
}

function SessionAccessChoices({ read, write }: {
  read: () => Promise<RemoteSessionAccessState>;
  write: (mode: RemoteSessionAccessMode) => Promise<RemoteSessionAccessState>;
}) {
  const query = useQuery({ queryKey: sessionAccessQueryKey, queryFn: () => read(), refetchInterval: SESSION_ACCESS_REFRESH_MS, retry: false });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = query.data;
  const shown = state?.connected ? state.mode ?? state.effective : null;
  const note = state ? unchosenNote(state) : null;
  async function choose(mode: RemoteSessionAccessMode) {
    setConfirming(false);
    setFailed(false);
    setSaving(true);
    try {
      await write(mode);
    } catch {
      setFailed(true);
    }
    await query.refetch();
    setSaving(false);
  }
  return <LayoutSection>
    <LayoutSectionHeader><LayoutSectionTitle>{HEADING}</LayoutSectionTitle></LayoutSectionHeader>
    {query.isPending ? <div aria-label="Checking this computer's choice" className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none" /> : null}
    {query.isError && !state ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><span>Couldn't read this computer's choice.</span><Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button></div> : null}
    {state ? <RadioGroup aria-label={HEADING} value={shown ?? ""} onValueChange={next => { if (next === "all") setConfirming(true); else if (next === "off" || next === "created") void choose(next); }}>
      {describeChoices(state).map(choice => <FieldLabel key={choice.mode} htmlFor={`session-access-${choice.mode}`}><Field orientation="horizontal">
        <RadioGroupItem
          id={`session-access-${choice.mode}`}
          value={choice.mode}
          disabled={saving || choice.locked}
          onClick={() => { if (state.mode === null && shown === choice.mode) void choose(choice.mode); }}
        />
        <FieldContent>
          <FieldTitle>{choice.title}</FieldTitle>
          <FieldDescription>{choice.description}</FieldDescription>
          {choice.note ? <FieldDescription data-testid={`session-access-reason-${choice.mode}`}>{choice.note}</FieldDescription> : null}
        </FieldContent>
      </Field></FieldLabel>)}
    </RadioGroup> : null}
    {note ? <p role="status" data-testid="session-access-unchosen" className="text-sm text-muted-foreground">{note}</p> : null}
    {failed ? <p role="alert" className="text-sm text-destructive">Couldn't change this. Try again.</p> : null}
    <ConfirmModal
      open={confirming}
      title="Let other devices reach all sessions?"
      message="Your other devices, Workbot and agents working for you will be able to open any session on this computer, continue it, stop it and answer its questions and permission requests. You can turn this off here at any time."
      confirmLabel="Allow all sessions"
      cancelLabel="Cancel"
      onConfirm={() => void choose("all")}
      onCancel={() => setConfirming(false)}
    />
  </LayoutSection>;
}
