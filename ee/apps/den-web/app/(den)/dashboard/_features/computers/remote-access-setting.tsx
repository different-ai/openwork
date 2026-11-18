"use client";

import { useState, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { DenButton } from "../../../_components/ui/button";
import { DenSelect } from "../../../_components/ui/select";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { permissionLockReason } from "../../../_lib/den-org";
import { ItemSection } from "../../_components/item-list";
import { SavedUndoLine, SettingRow } from "../../_components/scoped-setting";
import { hairline, secondaryText } from "./computer-parts";
import { remoteAccessSettingsErrorStatus, useRemoteAccessSettings, useSaveRemoteAccessSettings } from "./remote-access-data";

/*
 * The organization's limit on what other devices (a member's own, Workbot,
 * agents working for them) may do on its members' computers. It only limits
 * what a member may choose for their own computers in Desktop Settings ›
 * Devices: raising it changes nothing until a member also turns it on, and it
 * never opens one member's computer to another. `off` is the one value that
 * acts by itself: nobody's computer takes anything from other devices.
 */
export const REMOTE_ACCESS_OPTIONS: ReadonlyArray<{ value: RemoteSessionAccessMode; title: string; description: string }> = [
  {
    value: "off",
    title: "Off",
    description: "Nobody's computer takes tasks or shares sessions with other devices.",
  },
  {
    value: "created",
    title: "Start tasks on a computer",
    description: "Members' other devices, Workbot and agents working for them can start tasks on a computer and follow the ones they started.",
  },
  {
    value: "all",
    title: "Start tasks and open sessions, if the member turns it on",
    description: "A member can also let their other devices reach sessions started on their own computer. Each member chooses per computer, and it never gives anyone access to another member's sessions.",
  },
];

/** Added to "Start tasks on a computer" while a computer takes nothing until its owner allows it. */
export const REMOTE_ACCESS_OPT_IN_LINE = "Each member allows their computers themselves; until they do, nothing reaches them.";

export const REMOTE_ACCESS_SETTING_LABEL = "What other devices can do on computers";
const LABEL_ID = "session-access-label";

const SAVED_LINES: Record<RemoteSessionAccessMode, string> = {
  off: "Saved. Other devices can no longer reach any computer in this organization.",
  created: "Saved. Other devices can start tasks on a computer, and nothing more.",
  all: "Saved. Members can now let other devices open sessions on their own computers.",
};

/**
 * The choices the select offers. "Start tasks and open sessions" is offered only while the
 * organization can choose it, or while it is the value in force, so the
 * select always shows what applies.
 */
export function remoteAccessChoices(access: RemoteSessionAccessMode, allowsAll: boolean): RemoteSessionAccessMode[] {
  return REMOTE_ACCESS_OPTIONS.map((option) => option.value).filter((value) => value !== "all" || allowsAll || access === "all");
}

/** One line of what a value means for the organization. */
export function remoteAccessMeaning(access: RemoteSessionAccessMode, optIn: boolean): string {
  const description = REMOTE_ACCESS_OPTIONS.find((option) => option.value === access)?.description ?? "";
  return access === "created" && optIn ? `${description} ${REMOTE_ACCESS_OPT_IN_LINE}` : description;
}

/**
 * Whether a save can be taken back. "Start tasks and open sessions" can only be saved while
 * the organization may choose it, so a save that narrowed it from there, in
 * an organization that no longer may, has no Undo: Den would refuse it.
 */
export function remoteAccessUndoable(previous: RemoteSessionAccessMode, allowsAll: boolean): boolean {
  return previous !== "all" || allowsAll;
}

/** An API from before the setting was served on every Computers page answers 404: there is then no row to show. */
export function remoteAccessSettingUnavailable(error: unknown): boolean {
  return remoteAccessSettingsErrorStatus(error) === 404;
}

function parseAccess(value: string): RemoteSessionAccessMode | null {
  return REMOTE_ACCESS_OPTIONS.find((option) => option.value === value)?.value ?? null;
}

/** The "Remote access" group on Manage › Computers: a rule heading over its one settings row. */
function Section({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return <div className="mb-8" aria-busy={busy || undefined}>
    <ItemSection variant="rule" title="Remote access" testId="session-access-setting">
      <div className={`border-b ${hairline}`}>{children}</div>
    </ItemSection>
  </div>;
}

export function RemoteAccessSettingView({ access, allowsAll = true, optIn = false, canEdit, saving, saved, undoable = true, error, onChange, onUndo }: {
  access: RemoteSessionAccessMode;
  /** "Start tasks and open sessions" can be chosen. Older APIs do not say, and there it always could. */
  allowsAll?: boolean;
  /** A computer whose owner has not chosen takes nothing. */
  optIn?: boolean;
  canEdit: boolean;
  saving: boolean;
  /** Set right after a save, until it is undone or the page is left. */
  saved: RemoteSessionAccessMode | null;
  /** The value before the save can still be chosen. False: the saved line has no Undo. */
  undoable?: boolean;
  error: string | null;
  onChange: (access: RemoteSessionAccessMode) => void;
  onUndo: () => void;
}) {
  const choices = remoteAccessChoices(access, allowsAll);
  return <Section>
    {/* One line of what the current value means, under the row. */}
    <SettingRow flush label={REMOTE_ACCESS_SETTING_LABEL} labelId={LABEL_ID} stateLine={<span data-testid="session-access-meaning">{remoteAccessMeaning(access, optIn)}</span>}>
      <div className="w-[26rem] max-w-full">
        <DenSelect size="sm" aria-labelledby={LABEL_ID} data-testid="session-access-select" value={access} disabled={!canEdit || saving}
          onChange={(event) => { const next = parseAccess(event.target.value); if (next && next !== access && choices.includes(next)) onChange(next); }}>
          {REMOTE_ACCESS_OPTIONS.filter((option) => choices.includes(option.value)).map((option) => <option key={option.value} value={option.value} data-testid={`session-access-${option.value}`}>{option.title}</option>)}
        </DenSelect>
      </div>
    </SettingRow>
    {!canEdit ? <p className={`flex items-start gap-2 pb-3 text-[13px] ${secondaryText}`} data-testid="session-access-locked">
      <LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />{permissionLockReason("organization.update")}
    </p> : null}
    {error ? <p role="alert" className="break-words pb-3 text-[13px] text-[var(--ow-danger)]">{error}</p> : null}
    {saved && !error ? <div className="-mx-1 pb-3"><SavedUndoLine message={SAVED_LINES[saved]} pending={saving} onUndo={undoable ? onUndo : undefined} /></div> : null}
  </Section>;
}

/**
 * Manage › Computers: what members may let their other devices reach, or
 * nothing at all. Saves on change, with Undo. The row is there whenever Den
 * serves the setting; an API from before it was served on every Computers
 * page answers 404, and then there is no row.
 */
export function RemoteAccessSetting({ orgId }: { orgId: string }) {
  const query = useRemoteAccessSettings(orgId, true);
  const save = useSaveRemoteAccessSettings(orgId);
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

  if (!query.data && remoteAccessSettingUnavailable(query.error)) return null;
  if (!query.data || !current) return <Section busy={query.isPending}>
    <SettingRow flush label={REMOTE_ACCESS_SETTING_LABEL} labelId={LABEL_ID}>
      {query.error ? <div role="alert" className="flex flex-wrap items-center justify-end gap-3 text-[13px]"><p>{query.error.message}</p><DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton></div>
        : <DenSkeleton className="h-8 w-[26rem] max-w-full rounded-lg" />}
    </SettingRow>
  </Section>;

  const undoable = saved ? remoteAccessUndoable(saved.previous, query.data.allowsAll) : true;
  return <RemoteAccessSettingView
    access={save.isPending && save.variables ? save.variables : current}
    allowsAll={query.data.allowsAll}
    optIn={query.data.optIn}
    canEdit={query.data.canEdit}
    saving={save.isPending}
    saved={saved?.access ?? null}
    undoable={undoable}
    error={error}
    onChange={(next) => void change(next, false)}
    onUndo={() => { if (saved && undoable) void change(saved.previous, true); }}
  />;
}
