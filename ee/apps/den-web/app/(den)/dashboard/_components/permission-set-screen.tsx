"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ChevronRight, History, LockKeyhole, ShieldCheck } from "lucide-react";
import { PERMISSION_KEYS, getPermissionDefinition, isPermissionKey, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getPermissionsRoute, getTeamRoute, permissionLockReason } from "../../_lib/den-org";
import { useDenToast } from "./den-toast";
import {
  PermissionsRequestError,
  usePermissionSet,
  usePermissionSetHistory,
  useRemoveTeamPermissions,
  useUpdatePermissionSet,
  type PermissionChange,
  type PermissionHistoryItem,
  type PermissionSetDetail,
  type PermissionStatus,
} from "./permissions-data";
import {
  PermissionEditor,
  PermissionRowsSkeleton,
  PermissionsAccessState,
  PermissionsPage,
  RelativeTime,
  usePermissionsAccess,
  type PermissionEditorRow,
  type PermissionsAccess,
} from "./permissions-ui";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;
type SetTab = "permissions" | "history";

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function PermissionSetScreen({ permissionSetId }: { permissionSetId: string }) {
  const permissions = usePermissionsAccess();
  if (permissions.state !== "ready") {
    return <PermissionsPage title="Permissions" testId="permission-set"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return <PermissionSetContent key={permissionSetId} ready={permissions} permissionSetId={permissionSetId} />;
}

function PermissionSetContent({ ready, permissionSetId }: { ready: ReadyAccess; permissionSetId: string }) {
  const query = usePermissionSet(ready.orgId, permissionSetId);
  // Lives above the editor, which remounts after each save, so Undo and errors survive it.
  const update = useUpdatePermissionSet(ready.orgId, permissionSetId);
  const [tab, setTab] = useState<SetTab>("permissions");
  const back = { href: getPermissionsRoute(ready.orgSlug), label: "Permissions" };

  if (query.isError) {
    const notFound = query.error instanceof PermissionsRequestError && query.error.status === 404;
    return (
      <PermissionsPage title="Permissions" back={back} testId="permission-set">
        <div className="flex flex-col items-start gap-2">
          <DenNotice tone="error" className="w-full" message={notFound ? "These permissions don't exist anymore. Go back to Permissions to see what's current." : query.error instanceof Error ? query.error.message : "Couldn't load these permissions."} />
          {notFound ? null : <DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>}
        </div>
      </PermissionsPage>
    );
  }
  if (!query.data) {
    return <PermissionsPage title="Permissions" back={back} testId="permission-set"><PermissionRowsSkeleton /></PermissionsPage>;
  }

  const set = query.data;
  const tabs: readonly TabItem<SetTab>[] = [
    { value: "permissions", label: "Permissions", icon: ShieldCheck },
    { value: "history", label: "History", icon: History },
  ];
  const removable = set.kind === "team" && set.archivedAt === null && ready.access.canManagePermissions;

  return (
    <PermissionsPage
      title={set.name}
      back={back}
      caption={`${set.allowedCount} of ${PERMISSION_KEYS.length} allowed`}
      action={removable ? <RemoveTeamPermissions ready={ready} set={set} /> : undefined}
      testId="permission-set"
    >
      <AppliesTo ready={ready} set={set} />
      <UnderlineTabs tabs={tabs} activeTab={tab} onChange={setTab} />
      {tab === "permissions" ? (
        <div role="tabpanel" aria-label="Permissions">
          {/* Remount when the saved state changes so the draft starts from it. */}
          <PermissionSetEditor key={set.permissions.map((state) => state.status).join("")} ready={ready} set={set} update={update} />
        </div>
      ) : (
        <div role="tabpanel" aria-label="History">
          <PermissionSetHistory ready={ready} setId={set.id} />
        </div>
      )}
    </PermissionsPage>
  );
}

function AppliesTo({ ready, set }: { ready: ReadyAccess; set: PermissionSetDetail }) {
  const appliesTo = set.appliesTo;
  if (set.archivedAt) {
    return <DenNotice tone="neutral" icon={LockKeyhole} message={`Removed ${new Date(set.archivedAt).toLocaleDateString()}. These permissions no longer apply to anyone and can't be changed.`} />;
  }
  if (appliesTo.kind === "everyone") {
    return <p className="text-[13px] text-gray-600" data-testid="permission-set-applies-to">Applies to everyone in the organization, {plural(appliesTo.memberCount, "member")}.</p>;
  }
  if (appliesTo.kind === "admins") {
    const people = appliesTo.directAdmins;
    return (
      <details className="group text-[13px] text-gray-600" data-testid="permission-set-applies-to">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400">
          <ChevronRight className="size-3.5 text-gray-400 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
          Applies to {plural(people.length, "admin")} and {plural(appliesTo.adminTeams.length, "Admin team")}
        </summary>
        <ul className="mt-2 flex flex-col gap-1 pl-5">
          {people.map((person) => <li key={person.memberId}>{person.name} <span className="text-gray-500">{person.email}</span></li>)}
          {appliesTo.adminTeams.map((team) => (
            <li key={team.id}>
              {ready.access.canViewTeams ? <Link className="underline-offset-2 hover:underline" href={getTeamRoute(ready.orgSlug, team.id)}>{team.name}</Link> : team.name} team <span className="text-gray-500">{plural(team.memberCount, "member")}</span>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  const team = appliesTo.team;
  const teamName = team?.name ?? "A deleted team";
  return (
    <details className="group text-[13px] text-gray-600" data-testid="permission-set-applies-to">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400">
        <ChevronRight className="size-3.5 text-gray-400 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        Applies to the {teamName} team, {plural(appliesTo.members.length, "member")}
      </summary>
      <ul className="mt-2 flex flex-col gap-1 pl-5">
        {appliesTo.members.length === 0 ? <li className="text-gray-500">Nobody is in this team yet.</li> : null}
        {appliesTo.members.map((person) => <li key={person.memberId}>{person.name} <span className="text-gray-500">{person.email}</span></li>)}
        {team && ready.access.canViewTeams ? <li><Link className="underline-offset-2 hover:underline" href={getTeamRoute(ready.orgSlug, team.id)}>Open the {teamName} team</Link></li> : null}
      </ul>
    </details>
  );
}

/** Why a key can't be changed in this set by this person, or null. */
function keyLockReason(ready: ReadyAccess, set: PermissionSetDetail, key: PermissionKey, saved: PermissionStatus, locked: boolean): string | null {
  if (locked) return "Always on for admins";
  if (saved === "allow" || ready.held.has(key)) return null;
  const defaultKey = set.kind === "member_default" ? "member" : set.kind === "admin_default" ? "admin" : null;
  // Re-allowing a key that is on by default in this default set is always allowed.
  if (defaultKey && getPermissionDefinition(key).defaultOn.includes(defaultKey)) return null;
  return "You don't have this permission";
}

function setReadOnlyReason(ready: ReadyAccess, set: PermissionSetDetail): string | null {
  if (set.archivedAt) return "These permissions were removed and can't be changed.";
  if (!ready.access.canManagePermissions) return `Read only. ${permissionLockReason("permissions.manage")}`;
  if (set.kind === "admin_default" && !ready.access.isAdmin) return "Read only. Only the owner and admins can change Admin permissions.";
  return null;
}

function PermissionSetEditor({ ready, set, update }: { ready: ReadyAccess; set: PermissionSetDetail; update: ReturnType<typeof useUpdatePermissionSet> }) {
  const [draft, setDraft] = useState<ReadonlyMap<string, PermissionStatus>>(new Map());
  const toast = useDenToast();
  const readOnlyReason = setReadOnlyReason(ready, set);

  const rows: PermissionEditorRow[] = set.permissions.flatMap((state) => {
    if (!isPermissionKey(state.key)) return [];
    return [{
      key: state.key,
      status: state.status,
      draft: draft.get(state.key) ?? state.status,
      lockedReason: keyLockReason(ready, set, state.key, state.status, state.locked),
    }];
  });
  const changes: PermissionChange[] = rows.filter((row) => row.draft !== row.status).map((row) => ({ key: row.key, status: row.draft }));

  function toggle(key: PermissionKey, next: PermissionStatus) {
    update.reset();
    setDraft((current) => {
      const saved = set.permissions.find((state) => state.key === key)?.status;
      const copy = new Map(current);
      if (next === saved) copy.delete(key);
      else copy.set(key, next);
      return copy;
    });
  }

  async function save(toSave: PermissionChange[], undoable: boolean) {
    await update.mutateAsync(toSave);
    const count = plural(toSave.length, "change");
    toast({
      title: undoable ? `Saved ${count}` : `Undid ${count}`,
      action: undoable
        ? {
            label: "Undo",
            onClick: async () => {
              const inverse = toSave.map((change): PermissionChange => ({ key: change.key, status: change.status === "allow" ? "deny" : "allow" }));
              try {
                await save(inverse, false);
              } catch {
                return;
              }
            },
          }
        : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <PermissionEditor
        rows={rows}
        onToggle={toggle}
        readOnlyReasonId={readOnlyReason ? "permission-set-read-only" : undefined}
        beforeList={readOnlyReason ? <DenNotice tone="neutral" icon={LockKeyhole} message={<span id="permission-set-read-only">{readOnlyReason}</span>} /> : null}
      />
      {update.error ? <DenNotice tone="error" message={update.error.message} /> : null}
      {changes.length > 0 ? (
        <DenStickyActionBar testId="permission-set-save-bar" summary={<span>{plural(changes.length, "unsaved change")}</span>}>
          <DenButton variant="secondary" disabled={update.isPending} onClick={() => { update.reset(); setDraft(new Map()); }}>Discard</DenButton>
          <DenButton loading={update.isPending} onClick={() => void save(changes, true).catch(() => undefined)}>Save changes</DenButton>
        </DenStickyActionBar>
      ) : null}
    </div>
  );
}

const SOURCE_LABELS: Record<Exclude<PermissionHistoryItem["source"], "user">, { allow: string; deny: string }> = {
  seed: { allow: "allowed by default", deny: "not allowed by default" },
  reconcile: { allow: "added by an update", deny: "left off by an update" },
  migration: { allow: "allowed by a migration", deny: "removed by a migration" },
};

function HistorySentence({ item }: { item: PermissionHistoryItem }) {
  const label = item.label ?? "A permission that no longer exists";
  if (item.source === "user") {
    const who = item.changedBy?.name ?? item.changedBy?.email ?? "A former member";
    return <><span className="font-medium text-gray-900">{who}</span> {item.status === "allow" ? "allowed" : "removed"} <span className="font-medium text-gray-900">{label}</span></>;
  }
  return <><span className="font-medium text-gray-900">{label}</span> {SOURCE_LABELS[item.source][item.status]}</>;
}

function PermissionSetHistory({ ready, setId }: { ready: ReadyAccess; setId: string }) {
  const history = usePermissionSetHistory(ready.orgId, setId, true);
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  if (history.isPending) return <PermissionRowsSkeleton rows={5} label="Loading history" />;
  return (
    <div className="flex flex-col gap-3" data-testid="permission-set-history">
      {history.isError ? (
        <div className="flex flex-col items-start gap-2">
          <DenNotice tone="error" className="w-full" message={items.length > 0 ? "Couldn't load more history. Showing what loaded." : history.error instanceof Error ? history.error.message : "Couldn't load history."} />
          <DenButton variant="secondary" size="sm" disabled={history.isFetching} onClick={() => void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())}>Try again</DenButton>
        </div>
      ) : null}
      {items.length === 0 && !history.isError ? <p className="py-3 text-[13px] text-gray-500">No changes yet.</p> : null}
      <ol className="flex flex-col [&>*]:border-b [&>*]:border-gray-100">
        {items.map((item) => (
          <li key={item.id} className="flex min-h-11 items-center gap-3 py-2" data-testid="permission-history-row" data-source={item.source} data-status={item.status}>
            <p className="min-w-0 flex-1 truncate text-[13px] text-gray-600"><HistorySentence item={item} /></p>
            <RelativeTime value={item.createdAt} />
          </li>
        ))}
      </ol>
      {history.hasNextPage ? (
        <DenButton variant="secondary" size="sm" className="w-fit" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Show older changes</DenButton>
      ) : null}
    </div>
  );
}

function RemoveTeamPermissions({ ready, set }: { ready: ReadyAccess; set: PermissionSetDetail }) {
  const router = useRouter();
  const toast = useDenToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const remove = useRemoveTeamPermissions(ready.orgId, set.id);
  const teamName = set.team?.name ?? "this team";

  async function confirm() {
    try {
      await remove.mutateAsync();
      setOpen(false);
      toast({ title: `Removed ${set.name}` });
      router.push(getPermissionsRoute(ready.orgSlug));
    } catch {
      return;
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!remove.isPending) { remove.reset(); setOpen(next); } }}>
      <AlertDialog.Trigger className={buttonVariants({ variant: "secondary", size: "sm" })} data-testid="remove-team-permissions">Remove</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <AlertDialog.Popup initialFocus={cancelRef} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
          <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove {set.name}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">
            People in {teamName} lose these permissions now, unless another set gives them. The history is kept. This can&apos;t be undone.
          </AlertDialog.Description>
          {remove.error ? <DenNotice tone="error" className="mt-3" message={remove.error.message} /> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} disabled={remove.isPending} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
            <DenButton variant="destructive" loading={remove.isPending} onClick={() => void confirm()}>Remove permissions</DenButton>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
