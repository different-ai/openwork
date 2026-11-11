import type { OrganizationRegisteredInstance } from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../_components/ui/button";
import { DenTable, type DenTableColumn } from "../../../_components/ui/table";
import { TimeAgo, secondaryText } from "./computer-parts";
import { devicePageCount } from "./computers-format";

const STATUS_LABELS: Record<OrganizationRegisteredInstance["status"], string> = {
  provisioning: "Provisioning", healthy: "Healthy", failed: "Failed", stopped: "Stopped",
};

/** A stored healthy status does not establish a live connection. Heartbeat remains a separate fact. */
export function registeredInstanceStatus(instance: Pick<OrganizationRegisteredInstance, "status">): string {
  return STATUS_LABELS[instance.status];
}

export function RegisteredInstances({ instances, total, page, pageSize, busy, onPage, now }: {
  instances: OrganizationRegisteredInstance[];
  total: number;
  page: number;
  pageSize: number;
  busy: boolean;
  onPage: (page: number) => void;
  now: number;
}) {
  const columns: DenTableColumn<OrganizationRegisteredInstance>[] = [
    { key: "name", header: "Instance", render: (instance) => <span className="break-words font-medium">{instance.name}</span> },
    { key: "owner", header: "Owner", render: (instance) => <span title={instance.owner?.email ?? undefined}>{instance.owner?.name?.trim() || instance.owner?.email || "Not reported"}</span> },
    { key: "destination", header: "Type", render: (instance) => instance.destination === "local" ? "Local instance" : "Cloud instance" },
    { key: "status", header: "Reported status", render: registeredInstanceStatus },
    { key: "lastSeen", header: "Last contact", render: (instance) => instance.lastSeenAt ? <TimeAgo iso={instance.lastSeenAt} now={now} className="whitespace-nowrap tabular-nums" /> : "Never reported" },
    { key: "version", header: "Version", render: (instance) => instance.version ?? "Not reported" },
    { key: "provider", header: "Provider", render: (instance) => instance.provider ?? "Not reported" },
    { key: "region", header: "Region", render: (instance) => instance.region ?? "Not reported" },
  ];
  const pages = devicePageCount(total, pageSize);
  return <section className="mt-8 min-w-0" aria-labelledby="openwork-instances-heading" data-testid="registered-instances">
    <h2 id="openwork-instances-heading" className="mb-3 text-sm font-medium">OpenWork instances <span className={`ml-2 font-normal tabular-nums ${secondaryText}`}>{total.toLocaleString("en-US")}</span></h2>
    {instances.length ? <DenTable columns={columns} rows={instances} getRowKey={(instance) => instance.id} density="compact" />
      : <p className={`text-sm ${secondaryText}`}>No registered OpenWork instances match this view.</p>}
    {pages > 1 ? <nav aria-label="OpenWork instance pages" className={`mt-4 flex items-center justify-end gap-3 text-xs ${secondaryText}`}>
      <span>Page {page} of {pages}</span>
      <DenButton variant="secondary" size="sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>Previous instances</DenButton>
      <DenButton variant="secondary" size="sm" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>Next instances</DenButton>
    </nav> : null}
  </section>;
}
