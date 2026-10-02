/** Device-observed member changes, deliberately separate from server audit events. */
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
  /** A content revision, never a credential or connectivity/health timestamp. */
  revision: string | null;
  /** Existing in-app destination; not an external URL. */
  href: string;
  /** Optional service identity for the existing logo component. */
  serviceId?: string;
  /** Owning plugin, when this resource is a skill from an assigned plugin. */
  pluginName?: string;
  /** Marketplace the plugin (or the skill's plugin) was assigned through. */
  marketplaceName?: string;
  /** Number of skills a plugin carries. */
  skillCount?: number;
  /** Composer slash name and exact Connect capability, so a shared skill can be tried in a new session. */
  skillSlug?: string;
  capability?: string;
};

/** What was already shared when this device first verified the member's access. */
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
  /** Everything observed at or before this time has been seen in the Activity popover on this device. */
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
