"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { FEATURES, isFeatureKey, type FeatureKey } from "@openwork/features";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";
import { requestAdmin } from "./admin-request";

export type AdminFeatureUsageMember = {
  memberId: string;
  name: string | null;
  email: string | null;
  enabled: boolean;
  firstUsedAt: string;
  lastUsedAt: string;
  daysUsed: number;
};

export type AdminFeatureUsage = {
  key: FeatureKey;
  enabledMembers: number;
  usedLast7Days: number;
  usedLast30Days: number;
  members: AdminFeatureUsageMember[];
};

export type AdminOrganizationFeatureUsage = {
  activeMembers: number;
  features: AdminFeatureUsage[];
  generatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const optionalText = (value: unknown) => typeof value === "string" && value ? value : null;

function parseMember(value: unknown): AdminFeatureUsageMember | null {
  if (!isRecord(value) || typeof value.memberId !== "string" || typeof value.lastUsedAt !== "string") return null;
  return {
    memberId: value.memberId,
    name: optionalText(value.name),
    email: optionalText(value.email),
    enabled: value.enabled === true,
    firstUsedAt: typeof value.firstUsedAt === "string" ? value.firstUsedAt : value.lastUsedAt,
    lastUsedAt: value.lastUsedAt,
    daysUsed: count(value.daysUsed),
  };
}

/** GET /v1/admin/organizations/:id/feature-usage; unknown feature keys (newer server) are dropped. */
export function parseAdminOrganizationFeatureUsage(payload: unknown): AdminOrganizationFeatureUsage | null {
  if (!isRecord(payload) || !Array.isArray(payload.features)) return null;
  const features = payload.features.flatMap((entry): AdminFeatureUsage[] => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isFeatureKey(entry.key)) return [];
    const members = Array.isArray(entry.members) ? entry.members.flatMap((member) => parseMember(member) ?? []) : [];
    return [{ key: entry.key, enabledMembers: count(entry.enabledMembers), usedLast7Days: count(entry.usedLast7Days), usedLast30Days: count(entry.usedLast30Days), members }];
  });
  return { activeMembers: count(payload.activeMembers), features, generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString() };
}

/** Most used first, then most enabled; registry order breaks ties. */
export function sortFeatureUsage(features: readonly AdminFeatureUsage[]): AdminFeatureUsage[] {
  return features.map((feature, index) => ({ feature, index }))
    .sort((a, b) => b.feature.usedLast30Days - a.feature.usedLast30Days || b.feature.members.length - a.feature.members.length || b.feature.enabledMembers - a.feature.enabledMembers || a.index - b.index)
    .map(({ feature }) => feature);
}

/** "On for" cell: "3 of 12 members", "1 of 1 member". */
export const onFor = (enabled: number, total: number) => `${enabled} of ${total} ${total === 1 ? "member" : "members"}`;

const day = (value: string) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function MemberUsage({ feature }: { feature: AdminFeatureUsage }) {
  const columns: DenTableColumn<AdminFeatureUsageMember>[] = [
    { key: "member", header: "Member", render: (member) => <div className="min-w-0 break-words">
      <span className="font-medium text-gray-900">{member.name || member.email || "Unnamed member"}</span>
      {member.name && member.email ? <span className="ml-2 text-xs text-gray-500">{member.email}</span> : null}
    </div> },
    { key: "last", header: "Last used", width: "140px", render: (member) => day(member.lastUsedAt) },
    { key: "days", header: "Days used", width: "100px", align: "right", render: (member) => member.daysUsed },
    { key: "state", header: "Now", width: "90px", render: (member) => member.enabled ? "On" : <span className="text-gray-500">Off</span> },
  ];
  return <div className="pl-5" id={`admin-feature-usage-members-${feature.key}`} data-testid={`admin-feature-usage-members-${feature.key}`}>
    <DenTable columns={columns} rows={feature.members} getRowKey={(member) => member.memberId} density="compact" />
  </div>;
}

export function AdminOrganizationFeatureUsageView({ organizationId, refreshKey, onAccessFailure }: {
  organizationId: string;
  refreshKey: number;
  onAccessFailure: (failure: AdminFeatureAccessFailure) => void;
}) {
  const [usage, setUsage] = useState<AdminOrganizationFeatureUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<FeatureKey>>(new Set());
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/feature-usage`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void requestAdmin(path, parseAdminOrganizationFeatureUsage, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setUsage(result.data);
      else if (result.access === "signed-out" || result.access === "forbidden") onAccessFailure({ access: result.access, message: result.message });
      else setLoadError(result.message);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load feature usage.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, refreshKey, attempt, onAccessFailure]);

  function toggle(key: FeatureKey) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const columns: DenTableColumn<AdminFeatureUsage>[] = [
    { key: "feature", header: "Feature", render: (feature) => feature.members.length > 0
      ? <DenButton variant="plain" size="inline" type="button" aria-expanded={open.has(feature.key)} data-testid={`admin-feature-usage-toggle-${feature.key}`}
        aria-controls={`admin-feature-usage-members-${feature.key}`} onClick={() => toggle(feature.key)} className="-my-1.5">
        <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none ${open.has(feature.key) ? "rotate-90" : ""}`} />
        {FEATURES[feature.key].label}
      </DenButton>
      : <span className="pl-5 text-xs font-medium text-gray-900">{FEATURES[feature.key].label}</span> },
    { key: "enabled", header: "On for", width: "170px", render: (feature) => onFor(feature.enabledMembers, usage?.activeMembers ?? 0) },
    { key: "used", header: "Used", width: "210px", render: (feature) => feature.members.length === 0
      ? <span className="text-gray-500">No recorded use yet</span>
      : `${feature.usedLast30Days} in 30 days (${feature.usedLast7Days} in 7)` },
    { key: "last", header: "Last used", width: "130px", render: (feature) => feature.members[0] ? day(feature.members[0].lastUsedAt) : <span className="text-gray-500">Never</span> },
  ];

  const anyUse = usage?.features.some((feature) => feature.members.length > 0) ?? false;

  return (
    <section className="min-w-0 border-b border-gray-200 py-5" aria-label="Feature usage" aria-busy={loading} data-testid="admin-organization-feature-usage">
      <h2 className="text-sm font-semibold text-gray-900">Feature usage</h2>
      {loadError ? <div className="mt-3 text-sm text-red-700" role="alert">
        <p>{loadError}</p>
        <DenButton variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry feature usage</DenButton>
      </div> : null}
      {loading && !usage ? <div className="mt-3 grid gap-2" role="status" aria-label="Loading feature usage" data-testid="admin-feature-usage-loading">
        {[0, 1, 2, 3].map((row) => <div key={row} className="h-9 rounded-lg bg-gray-100" aria-hidden="true" />)}
      </div> : null}
      {usage ? <>
        {anyUse ? null : <p className="mt-3 text-sm text-gray-500" data-testid="admin-feature-usage-empty">No recorded use yet</p>}
        <div className="mt-3">
          <DenTable columns={columns} rows={sortFeatureUsage(usage.features)} getRowKey={(feature) => feature.key} density="compact"
            renderRowDetail={(feature) => open.has(feature.key) ? <MemberUsage feature={feature} /> : null} emptyLabel="No features on this deployment." />
        </div>
        <p className="mt-3 text-xs text-gray-500">Updated {new Date(usage.generatedAt).toLocaleString()}</p>
      </> : null}
    </section>
  );
}
