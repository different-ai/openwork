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

const sessionAccessQueryKey = ["desktop", "remote-session-access"] as const;
/** The organization's limit arrives when this computer next checks in, so an open page keeps reading. */
const SESSION_ACCESS_REFRESH_MS = 5_000;

/** Why "All sessions" cannot apply right now, or null when it can. */
function unavailableReason(state: RemoteSessionAccessState): string | null {
  if (!state.supported) return "Sign in again or update OpenWork to use this.";
  if (state.ceiling === null) return "Available once this computer is connected to your organization.";
  if (state.ceiling === "created") return "Your organization only allows sessions started remotely.";
  return null;
}

/** This computer's own choice of which sessions its owner's other devices can reach. Desktop only. */
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
  const reason = state ? unavailableReason(state) : null;
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
    <LayoutSectionHeader><LayoutSectionTitle>Sessions other devices can reach</LayoutSectionTitle></LayoutSectionHeader>
    {query.isPending ? <div aria-label="Checking session access" className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none" /> : null}
    {query.isError && !state ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><span>Couldn't read this computer's choice.</span><Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button></div> : null}
    {state ? <RadioGroup aria-label="Sessions other devices can reach" value={state.mode} onValueChange={next => { if (next === "created") void choose("created"); else if (next === "all") setConfirming(true); }}>
      <FieldLabel htmlFor="session-access-created"><Field orientation="horizontal">
        <RadioGroupItem id="session-access-created" value="created" disabled={saving} />
        <FieldContent><FieldTitle>Only sessions started remotely</FieldTitle><FieldDescription>Your other devices can follow and answer tasks they started here.</FieldDescription></FieldContent>
      </Field></FieldLabel>
      <FieldLabel htmlFor="session-access-all"><Field orientation="horizontal">
        <RadioGroupItem id="session-access-all" value="all" disabled={saving || reason !== null} />
        <FieldContent>
          <FieldTitle>All sessions on this computer</FieldTitle>
          <FieldDescription>Your other devices, Workbot and agents working for you can also open sessions you started here, continue them, stop them and answer their questions and permission requests.</FieldDescription>
          {reason ? <FieldDescription data-testid="session-access-reason">{state.mode === "all" ? `Not in effect. ${reason}` : reason}</FieldDescription> : null}
        </FieldContent>
      </Field></FieldLabel>
    </RadioGroup> : null}
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
