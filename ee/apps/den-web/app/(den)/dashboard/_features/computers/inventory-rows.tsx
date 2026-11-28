"use client";

import type { ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { COMPUTER_READ_SESSIONS_LABELS, type ComputerInventoryRow } from "@openwork/types/den/computer-inventory";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { StatusDot, secondaryText } from "./computer-parts";
import { ListRow, OwnerLane, RowLane, RowLaneLabel, RowList, RowListHeader, computerIcon } from "./computer-rows";
import { SHARED_COMPUTER_LABEL } from "./computers-format";
import { inventoryRunCode, inventoryStatus, onOff } from "./inventory-format";
import { remoteAccessNote, type RemoteAccessVoice } from "./remote-access";

const columns = {
  owner: "w-20 @4xl:w-32",
  status: "w-32 @4xl:w-36",
  runCode: "w-32 @4xl:w-36",
  sendTasks: "w-22 @4xl:w-24",
  readSessions: "w-34 @4xl:w-36",
};
const wideHeader = "sr-only @3xl:not-sr-only @3xl:block";
const bottom = "order-2 @3xl:order-none";
const compactRows = "[&_[data-inventory-row]]:min-h-12 [&_[data-inventory-row]]:py-1";

function InventoryRowHeader({ admin }: { admin: boolean }) {
  return <RowListHeader lead="Computer" menu={admin} chevron>
    {admin ? <RowLaneLabel lane={`${wideHeader} ${columns.owner}`}>Owner</RowLaneLabel> : null}
    <RowLaneLabel lane={columns.status}>Status</RowLaneLabel>
    <RowLaneLabel lane={`${wideHeader} ${columns.runCode}`}>Run code here</RowLaneLabel>
    <RowLaneLabel lane={`${wideHeader} ${columns.sendTasks}`}>Send it tasks</RowLaneLabel>
    <RowLaneLabel lane={`${wideHeader} ${columns.readSessions}`}>Read its sessions</RowLaneLabel>
  </RowListHeader>;
}

function MobileLabel({ children }: { children: ReactNode }) {
  return <span className={`block text-xs leading-4 @3xl:hidden ${secondaryText}`} aria-hidden="true">{children}</span>;
}

export function InventoryLock({ reason, decorative = false }: { reason: string; decorative?: boolean }) {
  return <LockKeyhole role="img" aria-label={reason} aria-hidden={decorative || undefined} className={`size-4 shrink-0 ${secondaryText}`} strokeWidth={1.5}><title>{reason}</title></LockKeyhole>;
}

export function sessionLockReason(sessions: ComputerInventoryRow["sessions"], voice: RemoteAccessVoice) {
  return sessions.access?.reason === "organization" ? remoteAccessNote(sessions.access, voice) : null;
}

function InventoryCells({ row, admin, now }: { row: ComputerInventoryRow; admin: boolean; now: number }) {
  const status = inventoryStatus(row.status, now);
  const run = inventoryRunCode(row.runCode, row.kind);
  const sessionsReason = sessionLockReason(row.sessions, admin ? "team" : "owner");
  const read = COMPUTER_READ_SESSIONS_LABELS[row.sessions.readSessions];
  return <>
    {admin ? <OwnerLane device={row} lane={`flex ${columns.owner} ${bottom}`} sharedLabel="Shared" /> : null}
    <div role="cell" data-status={row.status.state} className={`shrink-0 leading-5 ${columns.status}`} title={status.detail ?? undefined}>
      <span className="flex items-center gap-2"><StatusDot tone={status.tone} />{status.label}</span>
      {status.detail ? <span className={`block truncate pl-4 text-xs leading-4 ${secondaryText}`}>{status.detail}</span> : null}
    </div>
    <div role="cell" data-run-code={run.value} className={`shrink-0 leading-5 ${columns.runCode} ${bottom}`} title={run.reason ?? run.label}>
      <MobileLabel>Run code here</MobileLabel>
      <span className="flex items-center gap-1"><span className={run.locked ? secondaryText : "truncate"}>{run.label}</span>{run.locked && run.reason ? <InventoryLock reason={run.reason} /> : null}</span>
    </div>
    <div role="cell" data-send-tasks={row.sessions.sendTasks ? "on" : "off"} className={`shrink-0 leading-5 ${columns.sendTasks} ${bottom}`} title={!row.sessions.sendTasks ? sessionsReason ?? undefined : undefined}>
      <MobileLabel>Send it tasks</MobileLabel>
      <span className="flex items-center gap-1">{onOff(row.sessions.sendTasks)}{!row.sessions.sendTasks && sessionsReason ? <InventoryLock reason={sessionsReason} /> : null}</span>
    </div>
    <div role="cell" data-read-sessions={row.sessions.readSessions} className={`shrink-0 leading-5 ${columns.readSessions} ${bottom}`} title={sessionsReason ?? read}>
      <MobileLabel>Read its sessions</MobileLabel>
      <span className="flex items-center gap-1">{read}{sessionsReason ? <InventoryLock reason={sessionsReason} /> : null}</span>
    </div>
  </>;
}

export function InventoryRows({ rows, admin = false, openId, now, onToggle, rowAction, detail }: {
  rows: readonly ComputerInventoryRow[];
  admin?: boolean;
  openId: string;
  now: number;
  onToggle: (id: string) => void;
  rowAction?: (row: ComputerInventoryRow) => ReactNode;
  detail: (row: ComputerInventoryRow) => ReactNode;
}) {
  return <div className={compactRows}><RowList label={admin ? "Computers" : "My computers"} header={<InventoryRowHeader admin={admin} />}>
    {rows.map((row) => {
      const open = row.id === openId;
      const note = row.notes[0]?.message;
      const shared = !admin && row.shared ? SHARED_COMPUTER_LABEL : null;
      const description = [row.kindLabel, shared, note].filter(Boolean).join(", ");
      return <ListRow key={row.id} icon={computerIcon({ kind: row.kind === "desktop" ? "desktop" : "vm", provider: row.kind === "workbot" ? "workbot" : "other" })}
        rowTestId={`computer-inventory-row-${row.id}`} rowData={{ "data-inventory-row": "" }} name={row.label} wrapSecondLine
        secondLine={<span title={description}>{row.kindLabel}{shared ? <> <span className="ml-1">{shared}</span></> : null}{note ? <> <span className="ml-1">{note}</span></> : null}</span>}
        lanes={<InventoryCells row={row} admin={admin} now={now} />}
        below={<span aria-hidden="true" className="order-1 basis-full @3xl:hidden" />}
        action={admin ? rowAction?.(row) ?? null : undefined}
        toggle={{ expanded: open, controls: `computer-inventory-region-${row.id}`, onToggle: () => onToggle(row.id) }}>
        {open ? detail(row) : null}
      </ListRow>;
    })}
  </RowList></div>;
}

export function InventoryRowsSkeleton({ admin = false }: { admin?: boolean }) {
  return <div aria-hidden="true" className={compactRows}><RowList label={admin ? "Computers" : "My computers"} header={<InventoryRowHeader admin={admin} />}>
    {Array.from({ length: admin ? 5 : 3 }, (_, index) => <ListRow key={index}
      rowData={{ "data-inventory-row": "" }} lead={<DenSkeleton className="size-8 shrink-0 rounded-lg" />}
      name={<DenSkeleton className="h-3 w-24 max-w-full" />} secondLine={<DenSkeleton className="mt-1.5 h-2.5 w-16 max-w-full" />}
      lanes={<>
        {admin ? <RowLane lane={`${columns.owner} ${bottom}`}><DenSkeleton className="h-3 w-16" /></RowLane> : null}
        <RowLane lane={columns.status}><DenSkeleton className="h-3 w-20" /></RowLane>
        {[columns.runCode, columns.sendTasks, columns.readSessions].map((lane, column) => <RowLane key={column} lane={`${lane} ${bottom}`}><DenSkeleton className="h-3 w-16" /></RowLane>)}
        {admin ? <span className="w-7 shrink-0" /> : null}
        <span className="hidden w-4 shrink-0 @md:block" />
      </>}
      below={<span className="order-1 basis-full @3xl:hidden" />}
    />)}
  </RowList></div>;
}
