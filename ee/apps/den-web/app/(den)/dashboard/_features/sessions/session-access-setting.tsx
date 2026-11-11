"use client";

import { useState, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { DenButton } from "../../../_components/ui/button";
import { DenSelect } from "../../../_components/ui/select";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { orgFeatureEnabled, permissionLockReason, type DenOrgContext } from "../../../_lib/den-org";
import { ItemSection } from "../../_components/item-list";
import { SavedUndoLine, SettingRow } from "../../_components/scoped-setting";
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

export const SESSION_ACCESS_LABEL = "Sessions other devices can reach";
const LABEL_ID = "session-access-label";

const SAVED_LINES: Record<RemoteSessionAccessMode, string> = {
  created: "Saved. Other devices reach only sessions started remotely.",
  all: "Saved. Members can now choose all sessions for their own computers.",
};

function parseAccess(value: string): RemoteSessionAccessMode | null {
  return SESSION_ACCESS_OPTIONS.find((option) => option.value === value)?.value ?? null;
}

/** The "Remote access" group on Manage › Computers: a rule heading over its one settings row. */
function Section({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return <div className="mb-8" aria-busy={busy || undefined}>
    <ItemSection variant="rule" title="Remote access" testId="session-access-setting">
      <div className={`border-b ${hairline}`}>{children}</div>
    </ItemSection>
  </div>;
}

export function SessionAccessSettingView({ access, canEdit, saving, saved, error, onChange, onUndo }: {
  access: RemoteSessionAccessMode;
  canEdit: boolean;
  saving: boolean;
  /** Set right after a save, until it is undone or the page is left. */
  saved: RemoteSessionAccessMode | null;
  error: string | null;
  onChange: (access: RemoteSessionAccessMode) => void;
  onUndo: () => void;
}) {
  const current = SESSION_ACCESS_OPTIONS.find((option) => option.value === access) ?? SESSION_ACCESS_OPTIONS[0];
  return <Section>
    {/* One line of what the current value means, under the row. */}
    <SettingRow flush label={SESSION_ACCESS_LABEL} labelId={LABEL_ID} stateLine={<span data-testid="session-access-meaning">{current?.description}</span>}>
      <div className="w-72 max-w-full">
        <DenSelect size="sm" aria-labelledby={LABEL_ID} data-testid="session-access-select" value={access} disabled={!canEdit || saving}
          onChange={(event) => { const next = parseAccess(event.target.value); if (next && next !== access) onChange(next); }}>
          {SESSION_ACCESS_OPTIONS.map((option) => <option key={option.value} value={option.value} data-testid={`session-access-${option.value}`}>{option.title}</option>)}
        </DenSelect>
      </div>
    </SettingRow>
    {!canEdit ? <p className={`flex items-start gap-2 pb-3 text-[13px] ${secondaryText}`} data-testid="session-access-locked">
      <LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />{permissionLockReason("organization.update")}
    </p> : null}
    {error ? <p role="alert" className="break-words pb-3 text-[13px] text-[var(--ow-danger)]">{error}</p> : null}
    {saved && !error ? <div className="-mx-1 pb-3"><SavedUndoLine message={SAVED_LINES[saved]} pending={saving} onUndo={onUndo} /></div> : null}
  </Section>;
}

/** Manage › Computers: which sessions members may let their other devices reach. Saves on change, with Undo. */
export function SessionAccessSetting({ orgId }: { orgId: string }) {
  const query = useRemoteSessionSettings(orgId, true);
  const save = useSaveRemoteSessionSettings(orgId);
  const [saved, setSaved] = useState<{ access: RemoteSessionAccessMode; previous: RemoteSessionAccessMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  if (!query.data || !current) return <Section busy={query.isPending}>
    <SettingRow flush label={SESSION_ACCESS_LABEL} labelId={LABEL_ID}>
      {query.error ? <div role="alert" className="flex flex-wrap items-center justify-end gap-3 text-[13px]"><p>{query.error.message}</p><DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton></div>
        : <DenSkeleton className="h-8 w-72 max-w-full rounded-lg" />}
    </SettingRow>
  </Section>;

  return <SessionAccessSettingView
    access={save.isPending && save.variables ? save.variables : current}
    canEdit={query.data.canEdit}
    saving={save.isPending}
    saved={saved?.access ?? null}
    error={error}
    onChange={(next) => void change(next, false)}
    onUndo={() => { if (saved) void change(saved.previous, true); }}
  />;
}

/** The setting exists only while the organization has the remoteSessionAccess feature on. */
export function OrgSessionAccessSetting({ orgId, orgContext }: { orgId: string; orgContext: Pick<DenOrgContext, "features"> | null | undefined }) {
  if (!orgFeatureEnabled(orgContext, "remoteSessionAccess")) return null;
  return <SessionAccessSetting orgId={orgId} />;
}
