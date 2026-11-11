"use client";

import { useId, useState } from "react";
import { LockKeyhole } from "lucide-react";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { DenButton } from "../../../_components/ui/button";
import { DenOptionCard } from "../../../_components/ui/option-card";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { orgFeatureEnabled, permissionLockReason, type DenOrgContext } from "../../../_lib/den-org";
import { SavedUndoLine } from "../../_components/scoped-setting";
import { hairline, secondaryText } from "../computers/computer-parts";
import { useRemoteSessionSettings, useSaveRemoteSessionSettings } from "./sessions-data";

/*
 * The organization's ceiling. It only limits what a member may choose for
 * their own computers in Desktop Settings › Devices: raising it reaches no
 * session until a member also turns it on, and it never opens one member's
 * sessions to another.
 */
export const SESSION_ACCESS_OPTIONS: ReadonlyArray<{ value: RemoteSessionAccessMode; title: string; description: string }> = [
  {
    value: "created",
    title: "Only sessions started remotely",
    description: "Members can follow and answer tasks they started from another device.",
  },
  {
    value: "all",
    title: "All sessions, if the member turns it on",
    description: "A member can also let their other devices reach sessions started on their own computer. Each member chooses per computer, and it never gives anyone access to another member's sessions.",
  },
];

const SAVED_LINES: Record<RemoteSessionAccessMode, string> = {
  created: "Saved. Other devices reach only sessions started remotely.",
  all: "Saved. Members can now choose all sessions for their own computers.",
};

export function SessionAccessSettingView({ access, canEdit, saving, saved, error, onChange, onUndo, groupName = "session-access" }: {
  access: RemoteSessionAccessMode;
  canEdit: boolean;
  saving: boolean;
  /** Set right after a save, until it is undone or the page is left. */
  saved: RemoteSessionAccessMode | null;
  error: string | null;
  onChange: (access: RemoteSessionAccessMode) => void;
  onUndo: () => void;
  /** Groups the two radios; unique per instance so another group on the page cannot uncheck them. */
  groupName?: string;
}) {
  return <section className={`mt-10 border-t ${hairline} pt-6`} aria-labelledby="session-access-heading" data-testid="session-access-setting">
    <h2 id="session-access-heading" className="mb-3 text-sm font-medium">Sessions other devices can reach</h2>
    {!canEdit ? <p className={`mb-3 flex items-start gap-2 text-sm ${secondaryText}`} data-testid="session-access-locked">
      <LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />{permissionLockReason("organization.update")}
    </p> : null}
    <div role="radiogroup" aria-labelledby="session-access-heading" className="grid max-w-2xl gap-2">
      {SESSION_ACCESS_OPTIONS.map((option) => <DenOptionCard key={option.value} type="radio" name={groupName} testId={`session-access-${option.value}`}
        title={option.title} description={option.description} checked={access === option.value} disabled={!canEdit || saving}
        onChange={(checked) => { if (checked && option.value !== access) onChange(option.value); }} />)}
    </div>
    {error ? <p role="alert" className="mt-3 max-w-2xl break-words text-sm text-[var(--ow-danger)]">{error}</p> : null}
    {saved && !error ? <div className="mt-3 max-w-2xl"><SavedUndoLine message={SAVED_LINES[saved]} pending={saving} onUndo={onUndo} /></div> : null}
  </section>;
}

/** Manage › Computers: which sessions members may let their other devices reach. Saves on change, with Undo. */
export function SessionAccessSetting({ orgId }: { orgId: string }) {
  const query = useRemoteSessionSettings(orgId, true);
  const save = useSaveRemoteSessionSettings(orgId);
  const [saved, setSaved] = useState<{ access: RemoteSessionAccessMode; previous: RemoteSessionAccessMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groupName = useId();
  const current = query.data?.settings.access;

  async function change(next: RemoteSessionAccessMode, undo: boolean) {
    if (!current || current === next) return;
    setError(null);
    try {
      await save.mutateAsync(next);
      setSaved(undo ? null : { access: next, previous: current });
    } catch (failure) {
      setError(failure instanceof Error && failure.message.trim() ? failure.message : "Couldn't save this setting. Try again.");
    }
  }

  if (!query.data || !current) return <section className={`mt-10 border-t ${hairline} pt-6`} aria-labelledby="session-access-heading" data-testid="session-access-setting" aria-busy={query.isPending}>
    <h2 id="session-access-heading" className="mb-3 text-sm font-medium">Sessions other devices can reach</h2>
    {query.error ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p>{query.error.message}</p><DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton></div>
      : <div aria-hidden="true" className="grid max-w-2xl gap-2"><DenSkeleton className="h-16 w-full" /><DenSkeleton className="h-16 w-full" /></div>}
  </section>;

  return <SessionAccessSettingView
    access={save.isPending && save.variables ? save.variables : current}
    canEdit={query.data.canEdit}
    saving={save.isPending}
    saved={saved?.access ?? null}
    error={error}
    onChange={(next) => void change(next, false)}
    onUndo={() => { if (saved) void change(saved.previous, true); }}
    groupName={groupName}
  />;
}

/** The setting exists only while the organization has the remoteSessionAccess feature on. */
export function OrgSessionAccessSetting({ orgId, orgContext }: { orgId: string; orgContext: Pick<DenOrgContext, "features"> | null | undefined }) {
  if (!orgFeatureEnabled(orgContext, "remoteSessionAccess")) return null;
  return <SessionAccessSetting orgId={orgId} />;
}
