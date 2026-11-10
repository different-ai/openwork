"use client";

import type { PermissionKey } from "@openwork/types/den/permissions";
import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenNotice } from "../../_components/ui/notice";
import { permissionLockReason } from "../../_lib/den-org";
import { scopeChipState, scopeConflictLine, type TeamScope } from "./team-scope";

/*
 * The parts of a per-team control (see "Per-team controls" in this app's
 * AGENTS.md): a row, the chip that says where its value comes from, the way
 * back to Everyone's value, and the lines of state around it.
 */

/** One setting: its label on the left, its chip and one control on the right, an optional line of state under it. */
export function SettingRow({ label, labelId, aside, stateLine, children }: {
  label: string;
  labelId: string;
  /** Shown beside the label. */
  aside?: ReactNode;
  /** One line of state under the row, only while it is true. */
  stateLine?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-6 py-3">
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span id={labelId} className="text-[13px] font-medium text-gray-900">{label}</span>
          {aside}
        </span>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
      {stateLine ? <p className="mt-2 text-[13px] text-gray-500">{stateLine}</p> : null}
    </div>
  );
}

/** Where a row's value comes from. Renders nothing on Everyone's page while no team changed the value. */
export function ScopeChip({ scope, changed, changedTeams }: {
  scope: TeamScope;
  /** On a team's page: the team has its own value. */
  changed: boolean;
  /** On Everyone's page: the names of the teams with their own value. */
  changedTeams?: readonly string[];
}) {
  const state = scopeChipState(scope, { changed, changedTeams });
  if (!state) return null;
  return (
    <DenChip tone={state.tone} className="min-w-0 max-w-56" title={state.label} data-scope-chip={state.tone === "info" ? "changed" : "everyone"}>
      <span className="truncate">{state.label}</span>
    </DenChip>
  );
}

/** Puts a team back on Everyone's value. Show it only while the team has its own; it needs no confirmation. */
export function UseEveryonesButton({ settingLabel, disabled = false, onClick }: {
  /** The row's label, for assistive tech ("Use Everyone's setting for Default model"). */
  settingLabel: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Use Everyone's setting for ${settingLabel}`}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded text-[12px] text-gray-500 underline underline-offset-2 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-400 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-gray-500"
    >
      Use Everyone&apos;s
    </button>
  );
}

/** After a row saved on change: what is now true, and the way back. */
export function SavedUndoLine({ message, pending = false, onUndo }: { message: string; pending?: boolean; onUndo: () => void }) {
  return (
    <div role="status" className="flex items-center justify-between gap-3 px-1 text-[13px] text-gray-600">
      <span className="min-w-0 [overflow-wrap:anywhere]">{message}</span>
      <DenButton variant="ghost" size="xs" loading={pending} onClick={onUndo}>
        Undo
      </DenButton>
    </div>
  );
}

/** The one notice at the top of a panel the viewer can read but not change. Its controls stay visible, disabled. */
export function ReadOnlyNotice({ permission, id }: { permission: PermissionKey; id?: string }) {
  return <DenNotice tone="neutral" icon={LockKeyhole} message={<span id={id}>Read only. {permissionLockReason(permission)}</span>} />;
}

/** Under a team's rows, only while some of its members are on another team that disagrees. */
export function ConflictLine({ count, setting, testId }: { count: number; setting: string; testId?: string }) {
  if (count <= 0) return null;
  return <div className="px-6 py-3 text-[13px] text-gray-500" data-testid={testId}>{scopeConflictLine(count, setting)}</div>;
}
