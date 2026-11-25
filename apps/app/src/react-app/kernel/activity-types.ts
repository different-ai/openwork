export type ActivityScope = {
  baseUrl: string;
  organizationId: string;
  memberId: string;
};

export type ActivitySource = "providers" | "capabilities" | "connections";
export type ActivityResourceKind = "provider" | "skill" | "plugin" | "connection";

export type ActivityResource = {
  id: string;
  kind: ActivityResourceKind;
  label: string;
  revision: string | null;
  href: string;
  serviceId?: string;
  pluginName?: string;
  marketplaceName?: string;
  skillCount?: number;
  skillSlug?: string;
  capability?: string;
};

export type ActivityBaseline = {
  observedAt: number;
  labels: string[];
};

export type MemberActivityEntry = {
  id: string;
  resource: ActivityResource;
  change: "available" | "updated" | "unavailable";
  observedAt: number;
};

export type ActivityContext = {
  entries: MemberActivityEntry[];
  snapshots: Partial<Record<ActivitySource, ActivityResource[]>>;
  verifiedAt: number | null;
  seenAt?: number | null;
  baseline?: ActivityBaseline | null;
};

export function activityScopeKey(scope: ActivityScope): string {
  return JSON.stringify([scope.baseUrl.replace(/\/+$/, ""), scope.organizationId, scope.memberId]);
}

export const ACTIVITY_REFRESH_EVENT = "openwork-member-activity-refresh";

export function requestMemberActivityRefresh() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT));
}
