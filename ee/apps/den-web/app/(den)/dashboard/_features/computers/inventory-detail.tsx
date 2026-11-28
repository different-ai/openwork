"use client";

import { useId, useState, type ReactNode } from "react";
import { COMPUTER_READ_SESSIONS_LABELS, type ComputerInventoryDetailResponse, type ComputerMergedSignIn, type ComputerSourceAccess } from "@openwork/types/den/computer-inventory";
import { computerFolderSchema, type ComputerAccessSetting } from "@openwork/types/den/computers";
import { DenButton } from "../../../_components/ui/button";
import { DenCard } from "../../../_components/ui/card";
import { COMPACT_INPUT_CLASS, SECTION_TITLE_CLASS } from "../../../_components/ui/dashboard-styles";
import { DenInput } from "../../../_components/ui/input";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenSwitch } from "../../../_components/ui/switch";
import { markFeatureUsed } from "../../../_lib/feature-usage";
import { permissionLockReason } from "../../../_lib/den-org";
import { useDenToast } from "../../_components/den-toast";
import { ConfirmDialog, DisclosureSection } from "../../_components/item-list";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { TimeAgo, hairline, secondaryText } from "./computer-parts";
import { absoluteTime } from "./computers-format";
import { InventoryDetailActions, InventoryMergedSignIns, useInventoryActions } from "./inventory-actions";
import { saveWholeComputerChoice, useChangeComputerSourceAccess, useInventoryDetail, useRefreshInventory, type InventoryScope } from "./inventory-data";
import { computerRulesLine, inventoryOwnerName, onOff, runCodeLabel, runCodeReason } from "./inventory-format";
import { InventoryError } from "./inventory-parts";
import { InventoryLock, sessionLockReason } from "./inventory-rows";
import { MyComputerActivity } from "./my-computers-screen";
import { remoteAccessChangeHint, remoteAccessNote } from "./remote-access";

type Detail = ComputerInventoryDetailResponse;
const cardGrid = "grid gap-3 @3xl:grid-cols-3";

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return <DenCard className="min-w-0 space-y-2">
    <h3 className={SECTION_TITLE_CLASS}>{title}</h3>
    {children}
  </DenCard>;
}

function DetailValue({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return <div className={`flex min-h-10 flex-wrap items-center justify-between gap-x-2 border-b py-1 last:border-b-0 ${hairline}`}>
    <dt className={secondaryText}>{label}</dt>
    <dd className="min-w-0 wrap-anywhere">{value}</dd>
  </div>;
}

function Installed({ installed, now, onRemove }: { installed: Detail["installed"]; now: number; onRemove: (signIn: ComputerMergedSignIn) => Promise<void> }) {
  const { appVersion, signedInAs, addedAt, lastSeenAt, platform, mergedSignIns } = installed;
  const email = signedInAs?.email?.trim();
  const identity = [signedInAs?.name?.trim(), email?.toLowerCase().endsWith(".invalid") ? null : email].filter(Boolean).join(", ");
  return <DetailCard title="Installed">
    <dl>
      <DetailValue label="App version" value={appVersion} />
      <DetailValue label="Signed in as" value={identity} />
      <DetailValue label="Last contact" value={lastSeenAt ? <TimeAgo iso={lastSeenAt} now={now} /> : null} />
      <DetailValue label="Added date" value={<time dateTime={addedAt}>{absoluteTime(addedAt)}</time>} />
      <DetailValue label="Platform" value={platform} />
    </dl>
    <InventoryMergedSignIns signIns={mergedSignIns} now={now} onRemove={onRemove} installed />
  </DetailCard>;
}

function SourceRow({ detail, scope, source }: { detail: Detail; scope: InventoryScope; source: ComputerSourceAccess }) {
  const [confirming, setConfirming] = useState(false);
  const sourceLabelId = useId();
  const toast = useDenToast();
  const mutation = useChangeComputerSourceAccess(scope, detail.computer.id, source.key);
  const whole = source.scope === "whole_computer";
  const computer = detail.computer.label;
  const restore = source.revokedAt !== null;
  const label = restore ? "Allow again" : "Revoke";
  const canAct = restore ? detail.callerIsOwner && detail.runCode.canRestore : detail.runCode.canRevoke;
  const action = restore ? "restore" : "revoke";

  async function change(next: "restore" | "revoke") {
    const changed = await mutation.mutateAsync(next);
    toast({ title: next === "restore" ? "Allowed again" : "Revoked", description: changed.label });
  }

  return <li className={`flex min-h-10 flex-wrap items-start gap-2 border-t py-2 ${hairline}`} aria-busy={mutation.isPending}>
    <div className="min-w-0 flex-1">
      <p id={sourceLabelId} className="font-medium wrap-anywhere">{source.label}</p>
      <p className={secondaryText}>{whole ? "Whole computer" : "In sandbox"}</p>
      {source.folders.length ? <div className={`mt-1 text-xs ${secondaryText}`}>
        <span>{whole ? "Working folder" : "Shared folders"}</span>
        <ul>{source.folders.map((folder) => <li key={folder}><code className="wrap-anywhere">{folder}</code></li>)}</ul>
      </div> : !whole ? <p className={`text-xs ${secondaryText}`}>No shared folders</p> : null}
      {source.revokedAt ? <p className={`mt-1 text-xs wrap-anywhere ${secondaryText}`}>
        {source.revokedBy ? `Revoked by ${source.revokedBy} on ` : "Revoked on "}<time dateTime={source.revokedAt}>{absoluteTime(source.revokedAt)}</time>
      </p> : null}
      {mutation.error && mutation.variables === "restore" ? <p className="mt-1 text-xs text-[var(--ow-danger)]" role="alert">{mutation.error.message}</p> : null}
    </div>
    {canAct ? <DenButton variant="secondary" size="xs" aria-describedby={sourceLabelId} disabled={mutation.isPending}
      onClick={() => {
        if (action === "revoke") setConfirming(true);
        else void change(action).catch(() => {});
      }}>{label}</DenButton> : null}
    <ConfirmDialog destructive confirm={confirming ? {
      title: "Revoke access?",
      description: `${source.label} will no longer be able to run code on ${computer}. Only its owner can allow it again.`,
      action: "Revoke",
    } : null} onConfirm={() => change("revoke")} onClose={() => setConfirming(false)} />
  </li>;
}

function Sources({ detail, scope }: { detail: Detail; scope: InventoryScope }) {
  const sources = detail.runCode.sources;
  if (!sources.length) return null;
  return <ul aria-label="Sources of access">
    {sources.map((source) => <SourceRow key={source.key} source={source} detail={detail} scope={scope} />)}
  </ul>;
}

const SWITCH_LABEL = "Let my OpenWork apps use this whole computer";
const FOLDER_HINT = "Enter a full folder path, such as /home/openwork.";

function WholeComputerChoice({ detail, scope }: { detail: Detail; scope: InventoryScope }) {
  const { runReauthableAction } = useOrgDashboard();
  const toast = useDenToast();
  const refresh = useRefreshInventory(scope);
  const savedSource = detail.runCode.sources.find((source) => source.key === "owner_whole_vm" && !source.revokedAt);
  const checked = Boolean(savedSource) || detail.runCode.value.value === "whole_computer";
  const savedFolder = savedSource?.folders[0];
  const blocked = !detail.rules.runCode && !checked;
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderId = useId();
  const hintId = `${folderId}-hint`;
  const folder = checked ? savedFolder ?? "" : draft ?? savedFolder ?? "";
  const parsed = computerFolderSchema.safeParse(folder.trim());

  async function save(setting: ComputerAccessSetting) {
    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("change-whole-computer-access", () => saveWholeComputerChoice(scope.orgId, detail.computer.id, setting));
      markFeatureUsed("computers");
      toast({ title: setting.choice === "allow" ? "Allowed whole-computer access" : "Turned off whole-computer access" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function toggle(next: boolean) {
    if (busy) return;
    if (next) {
      if (parsed.success && !blocked) { setError(null); setConfirmFolder(parsed.data); }
      return;
    }
    setDraft(savedFolder ?? draft);
    void save({ choice: "off" }).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "Couldn't turn off whole-computer access. Try again.");
    });
  }

  return <div className={`space-y-2 border-t pt-2 ${hairline}`} aria-busy={busy}>
    <div className="flex min-h-10 items-center justify-between gap-3">
      <span>{SWITCH_LABEL}</span>
      <DenSwitch size="sm" aria-label={SWITCH_LABEL} aria-describedby={checked ? undefined : hintId}
        checked={checked} disabled={busy || blocked || (!checked && !parsed.success)} onChange={toggle} />
    </div>
    {checked ? savedFolder ? <p className={secondaryText}>Working folder: <code className="wrap-anywhere">{savedFolder}</code></p> : null : <div className="space-y-1">
      <label htmlFor={folderId} className={secondaryText}>Working folder</label>
      <DenInput id={folderId} className={COMPACT_INPUT_CLASS} autoComplete="off" spellCheck={false} placeholder="/home/openwork" required maxLength={1024}
        value={folder} aria-describedby={hintId} disabled={busy || blocked} onChange={(event) => setDraft(event.target.value)} />
      <p id={hintId} className={`text-xs ${secondaryText}`}>{blocked ? "An organization owner or admin can allow this in Organization settings." : FOLDER_HINT}</p>
    </div>}
    {error ? <p role="alert" className="text-[var(--ow-danger)]">{error}</p> : null}
    <ConfirmDialog confirm={confirmFolder !== null ? {
      title: `Allow whole-computer access to ${detail.computer.label}?`,
      description: `Your signed-in OpenWork apps will be able to read, change and delete anything on ${detail.computer.label}; work starts in ${confirmFolder}.`,
      action: "Allow whole-computer access",
    } : null} onConfirm={() => confirmFolder === null ? undefined : save({ choice: "allow", scope: "whole_vm", folders: [confirmFolder] })} onClose={() => setConfirmFolder(null)} />
  </div>;
}

function RunCode({ detail, scope }: { detail: Detail; scope: InventoryScope }) {
  const code = detail.runCode.value;
  const reason = runCodeReason(code);
  return <DetailCard title="Run code here">
    {code.value === "not_available" ? <p>{detail.computer.label} can&apos;t take work from other computers yet.</p> : <>
      <p>{runCodeLabel(code)}</p>
      {reason ? <p className={`flex items-start gap-2 text-xs ${secondaryText}`}>
        {code.value === "no" && code.reason === "organization" ? <InventoryLock reason={reason} /> : null}{reason}
      </p> : null}
    </>}
    <Sources detail={detail} scope={scope} />
    {code.value !== "not_available" && detail.computer.kind === "cloud" && detail.callerIsOwner && detail.runCode.canChange ? <WholeComputerChoice detail={detail} scope={scope} /> : null}
  </DetailCard>;
}

function Sessions({ detail }: { detail: Detail }) {
  const { access, sendTasks, readSessions } = detail.sessions;
  const voice = detail.callerIsOwner ? "owner" : "team";
  const note = access ? remoteAccessNote(access, voice) : null;
  const lock = sessionLockReason(detail.sessions, voice);
  const hint = access && detail.callerIsOwner ? remoteAccessChangeHint(access) : null;
  return <DetailCard title="Sessions">
    <dl>
      <DetailValue label="Send it tasks" value={onOff(sendTasks)} />
      <DetailValue label="Read its sessions" value={COMPUTER_READ_SESSIONS_LABELS[readSessions]} />
    </dl>
    {note ? <p className={`flex items-start gap-2 text-xs ${secondaryText}`}>{lock ? <InventoryLock reason={lock} /> : null}{note}</p> : null}
    {hint ? <p className={`text-xs ${secondaryText}`}>{hint}</p> : null}
  </DetailCard>;
}

function DetailActivity({ events, now }: { events: Detail["activity"]; now: number }) {
  const [open, setOpen] = useState(false);
  const newestFirst = open ? [...events].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)) : [];
  return <DisclosureSection label="Activity" open={open} onToggle={() => setOpen(!open)}>
    <div className="min-w-0 [&_li>p]:wrap-anywhere"><MyComputerActivity events={newestFirst} now={now} /></div>
  </DisclosureSection>;
}

function DetailSkeleton() {
  return <div className={cardGrid} aria-hidden="true">
    {[["Installed", 5], ["Run code here", 3], ["Sessions", 2]].map(([title, count]) => <DetailCard key={title} title={String(title)}>
      {Array.from({ length: Number(count) }, (_, index) => <div key={index} className="flex min-h-10 items-center justify-between gap-2"><DenSkeleton className="h-3 w-20" /><DenSkeleton className="h-3 w-16" /></div>)}
    </DetailCard>)}
  </div>;
}

export function InventoryDetail({ id, scope, onClose, onRemoved, canDisconnect = true, now }: {
  id: string;
  scope: InventoryScope;
  onClose?: () => void;
  onRemoved: (id: string) => void;
  canDisconnect?: boolean;
  now: number;
}) {
  const query = useInventoryDetail(scope, id);
  const { actionsFor, removeSignIn } = useInventoryActions(scope, onRemoved);
  const detail = query.data;
  const row = detail?.computer;
  const owner = row && inventoryOwnerName(row.owner);
  const ownerLine = owner ? `Only ${owner} can change these.` : row?.shared ? "This computer is shared with the organization." : "Only the owner can change these.";
  const adminCanRevoke = detail?.runCode.canRevoke && detail.runCode.sources.some((source) => !source.revokedAt);
  const disconnectLocked = scope.admin && !canDisconnect && row?.kind === "desktop" && !row.canDisconnect && !row.canRemove && !row.notes.some((note) => note.code === "disconnected");
  return <div data-testid={`computer-inventory-detail-${id}`} aria-busy={query.isFetching} className="@container space-y-3">
    {onClose ? <div className="flex min-h-10 items-center justify-between gap-2">
      <h2 className={SECTION_TITLE_CLASS}>{row?.label ?? "Computer"}</h2><DenButton variant="ghost" size="sm" onClick={onClose}>Close</DenButton>
    </div> : null}
    {query.error ? <InventoryError message={query.error.message} stale={detail ? "Showing the last known details." : undefined} checkedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} /> : null}
    {detail && row ? <>
      {scope.admin && !detail.callerIsOwner ? <div className={`space-y-1 ${secondaryText}`}>
        <p className="flex items-center gap-2"><InventoryLock reason={ownerLine} />
          <span>{ownerLine}{adminCanRevoke ? " You can revoke access." : ""}</span>
        </p>
        <p>{computerRulesLine(detail.rules)}</p>
      </div> : null}
      <div className={cardGrid}>
        <Installed installed={detail.installed} now={now} onRemove={removeSignIn} />
        <RunCode detail={detail} scope={scope} />
        <Sessions detail={detail} />
      </div>
      <InventoryDetailActions row={row} set={actionsFor(row, detail.installed.mergedSignIns)} />
      {disconnectLocked ? <p className={`flex items-center gap-2 ${secondaryText}`}><InventoryLock reason={permissionLockReason("computers.disconnect")} />{permissionLockReason("computers.disconnect")}</p> : null}
      {row.notes.length ? <ul aria-label="Computer notes" className={`space-y-1 ${secondaryText}`}>
        {row.notes.map((note, index) => <li key={`${note.code}-${index}`}>{note.message}</li>)}
      </ul> : null}
      <DetailActivity events={detail.activity} now={now} />
    </> : query.isPending ? <DetailSkeleton /> : null}
  </div>;
}
