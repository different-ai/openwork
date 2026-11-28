"use client";

import { useId, useState } from "react";
import type { ComputerInventoryRow, ComputerMergedSignIn } from "@openwork/types/den/computer-inventory";
import { DenButton } from "../../../_components/ui/button";
import { useDenToast } from "../../_components/den-toast";
import { ConfirmDialog } from "../../_components/item-list";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { ComputerActionButtons, RenameComputerDialog, type ComputerActionSet } from "./computer-action-controls";
import { disconnectOwnConfirm, disconnectTeamConfirm, disconnectedLine, myComputerActions, removeConfirm, teamComputerActions } from "./computer-actions";
import { TimeAgo, hairline, secondaryText } from "./computer-parts";
import { disconnectOrganizationComputer, removeOrganizationComputer } from "./computers-data";
import { countLabel } from "./computers-format";
import { useRefreshInventory, type InventoryScope } from "./inventory-data";
import { inventoryDate, inventoryOwnerName, mergedInventoryLine, removableMergedSignIns } from "./inventory-format";
import { disconnectMyComputer, removeMyComputer, renameMyComputer } from "./my-computers-data";

export function useInventoryActions(scope: InventoryScope, onRemoved?: (id: string) => void) {
  const { runReauthableAction } = useOrgDashboard();
  const refresh = useRefreshInventory(scope);
  const toast = useDenToast();
  const { orgId, admin } = scope;
  const remove = admin ? removeOrganizationComputer : removeMyComputer;
  const disconnect = admin ? disconnectOrganizationComputer : disconnectMyComputer;

  async function removeSignIn(signIn: ComputerMergedSignIn) {
    await runReauthableAction(admin ? "remove-computer" : "remove-my-computer", () => remove(orgId, signIn.id));
    toast({ title: `Removed ${signIn.label}’s older sign-in from the list` });
    await refresh();
  }

  function actionsFor(row: ComputerInventoryRow, signIns: readonly ComputerMergedSignIn[]): ComputerActionSet {
    const merged = removableMergedSignIns(signIns, row.id);
    const completed = new Set<string>();
    const confirm = removeConfirm(row.label);
    return {
      actions: admin && !row.canRename ? teamComputerActions(row) : myComputerActions(row),
      name: row.label,
      disconnectConfirm: admin ? disconnectTeamConfirm(row.label, inventoryOwnerName(row.owner) ?? "A member", scope.orgName) : disconnectOwnConfirm(row.label),
      removeConfirm: merged.length ? { ...confirm, description: `${confirm.description} This also removes ${countLabel(merged.length, "older sign-in")} from the list.` } : confirm,
      onDisconnect: async () => {
        await runReauthableAction(admin ? "disconnect-computer" : "disconnect-my-computer", async () => {
          const result = await disconnect(orgId, row.id);
          toast({ title: disconnectedLine(result.signedOut) });
        });
        await refresh();
      },
      onRemove: async () => {
        try {
          await runReauthableAction(admin ? "remove-computer" : "remove-my-computer", async () => {
            for (const signIn of merged) {
              if (completed.has(signIn.id)) continue;
              await remove(orgId, signIn.id);
              completed.add(signIn.id);
            }
            await remove(orgId, row.id);
          });
        } catch (error) {
          if (completed.size) void refresh();
          throw error;
        }
        toast({ title: `Removed ${row.label} from the list` });
        onRemoved?.(row.id);
        await refresh();
      },
      onRename: row.canRename ? async (label) => {
        await runReauthableAction("rename-my-computer", async () => { await renameMyComputer(orgId, row.id, label); });
        toast({ title: `Renamed to ${label}` });
        await refresh();
      } : undefined,
    };
  }

  return { actionsFor, removeSignIn };
}

export function InventoryDetailActions({ row, set }: { row: ComputerInventoryRow; set: ComputerActionSet }) {
  const [renaming, setRenaming] = useState(false);
  if (!set.actions.length) return null;
  return <div className="flex flex-wrap items-center gap-2">
    {set.onRename && set.actions.includes("rename") ? <>
      <DenButton variant="secondary" size="sm" onClick={() => setRenaming(true)}>Rename</DenButton>
      <RenameComputerDialog open={renaming} name={set.name} onRename={set.onRename} onClose={() => setRenaming(false)} />
    </> : null}
    <ComputerActionButtons set={set} idPrefix="computer-inventory" id={row.id} />
  </div>;
}

function MergedSignIn({ signIn, now, onRemove }: { signIn: ComputerMergedSignIn; now: number; onRemove: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return <li className={`grid min-h-10 grid-cols-2 items-center gap-x-3 gap-y-1 border-b py-2 text-xs last:border-b-0 @xl:grid-cols-[minmax(0,2fr)_minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(0,1fr)_3.5rem] @xl:py-1 ${hairline} ${secondaryText}`}>
    <span className="min-w-0 truncate text-[var(--dls-text-primary)]" title={signIn.label}>{signIn.label}</span>
    <span className="col-start-1 row-start-2 @xl:col-start-2 @xl:row-start-1">Added <time dateTime={signIn.addedAt}>{inventoryDate(signIn.addedAt)}</time></span>
    <span className="col-start-2 row-start-2 @xl:col-start-3 @xl:row-start-1">
      {signIn.lastSeenAt ? <>Last seen <TimeAgo iso={signIn.lastSeenAt} now={now} className="lowercase" /></> : "Never seen"}
    </span>
    {signIn.appVersion?.trim() ? <span className="col-start-1 row-start-3 wrap-anywhere @xl:col-start-4 @xl:row-start-1">App version {signIn.appVersion}</span> : null}
    {signIn.canRemove ? <div className="col-start-2 row-start-1 justify-self-end @xl:col-start-5">
      <DenButton variant="ghost" size="inline" onClick={() => setConfirming(true)} aria-label={`Remove older sign-in for ${signIn.label}`}>Remove</DenButton>
      <ConfirmDialog destructive confirm={confirming ? { ...removeConfirm(signIn.label), title: `Remove the older sign-in for ${signIn.label}?` } : null} onConfirm={onRemove} onClose={() => setConfirming(false)} />
    </div> : null}
  </li>;
}

export function InventoryMergedSignIns({ signIns, now, onRemove, installed = false }: {
  signIns: readonly ComputerMergedSignIn[];
  now: number;
  onRemove: (signIn: ComputerMergedSignIn) => Promise<void>;
  installed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!signIns.length) return null;
  return <div className="mt-2" data-testid={installed ? undefined : "computer-inventory-merged"}>
    <div className={`flex flex-wrap items-center gap-x-2 text-xs ${secondaryText}`}>
      <span>{installed ? `${countLabel(signIns.length, "older sign-in")} merged in` : mergedInventoryLine(signIns.length)}</span>
      <DenButton variant="ghost" size="inline" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</DenButton>
    </div>
    <ul id={id} hidden={!open} aria-label="Older sign-ins" className={`@container border-t ${hairline}`}>
      {open ? signIns.map((signIn) => <MergedSignIn key={signIn.id} signIn={signIn} now={now} onRemove={() => onRemove(signIn)} />) : null}
    </ul>
  </div>;
}
