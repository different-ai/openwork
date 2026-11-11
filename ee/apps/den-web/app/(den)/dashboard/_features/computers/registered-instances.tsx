import { Cloud, Server } from "lucide-react";
import type { OrganizationRegisteredInstance } from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../_components/ui/button";
import { ItemSection } from "../../_components/item-list";
import { secondaryText } from "./computer-parts";
import { LANE, ListRow, OwnerLane, RowLane, RowLaneLabel, RowList, RowListHeader, TimeLane, VersionLane } from "./computer-rows";
import { devicePageCount } from "./computers-format";

const STATUS_LABELS: Record<OrganizationRegisteredInstance["status"], string> = {
  provisioning: "Provisioning", healthy: "Healthy", failed: "Failed", stopped: "Stopped",
};

/** A stored healthy status does not establish a live connection. Heartbeat remains a separate fact. */
export function registeredInstanceStatus(instance: Pick<OrganizationRegisteredInstance, "status">): string {
  return STATUS_LABELS[instance.status];
}

/** What it is and where it runs: "Cloud instance, cloud, test-region". Nothing is invented for what was not reported. */
export function registeredInstanceLine(instance: Pick<OrganizationRegisteredInstance, "destination" | "provider" | "region">): string {
  return [instance.destination === "local" ? "Local instance" : "Cloud instance", instance.provider?.trim(), instance.region?.trim()].filter(Boolean).join(", ");
}

/** The owner as the computers' lane shows one: a member's name, or that none was reported. */
function InstanceOwner({ instance }: { instance: OrganizationRegisteredInstance }) {
  const named = instance.owner?.name?.trim() || instance.owner?.email?.trim();
  if (!named) return <RowLane lane={LANE.owner} className={`items-center ${secondaryText}`}><span className="truncate">Not reported</span></RowLane>;
  return <OwnerLane device={{ owner: instance.owner, shared: false }} />;
}

/** Registered OpenWork worker hosts, in the same rows as computers. Read-only: status is what was stored, not a live check. */
export function RegisteredInstances({ instances, total, filtered = false, page, pageSize, busy, onPage, now }: {
  instances: OrganizationRegisteredInstance[];
  total: number;
  /** The page is narrowed by a search: an empty section then says nothing matches instead of leaving. */
  filtered?: boolean;
  page: number;
  pageSize: number;
  busy: boolean;
  onPage: (page: number) => void;
  now: number;
}) {
  const pages = devicePageCount(total, pageSize);
  // An organization with no instances has no section about them.
  if (total === 0 && instances.length === 0 && !filtered) return null;
  return <div className="mt-10 min-w-0">
    <ItemSection variant="rule" title="OpenWork instances" meta={total.toLocaleString("en-US")} testId="registered-instances">
      {instances.length ? <RowList label="OpenWork instances" header={<RowListHeader lead="Instance">
        <RowLaneLabel lane={LANE.owner}>Owner</RowLaneLabel>
        <RowLaneLabel lane={LANE.status}>Reported status</RowLaneLabel>
        <RowLaneLabel lane={LANE.teamTime}>Last contact</RowLaneLabel>
        <RowLaneLabel lane={LANE.instanceVersion}>Version</RowLaneLabel>
      </RowListHeader>}>
        {instances.map((instance) => <ListRow key={instance.id} icon={instance.destination === "local" ? Server : Cloud} name={instance.name} secondLine={registeredInstanceLine(instance)}
          rowTestId={`registered-instance-${instance.id}`}
          lanes={<>
            <InstanceOwner instance={instance} />
            <RowLane lane={LANE.status} className="items-center"><span className="truncate">{registeredInstanceStatus(instance)}</span></RowLane>
            <TimeLane lane={LANE.teamTime} iso={instance.lastSeenAt} now={now} never="Never reported" />
            <VersionLane lane={LANE.instanceVersion} version={instance.version} />
          </>} />)}
      </RowList> : <p className={`py-4 text-[13px] ${secondaryText}`}>No OpenWork instances match this view.</p>}
    </ItemSection>
    {pages > 1 ? <nav aria-label="OpenWork instance pages" className={`mt-4 flex items-center justify-end gap-3 text-xs ${secondaryText}`}>
      <span>Page {page} of {pages}</span>
      <DenButton variant="secondary" size="sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>Previous instances</DenButton>
      <DenButton variant="secondary" size="sm" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>Next instances</DenButton>
    </nav> : null}
  </div>;
}
