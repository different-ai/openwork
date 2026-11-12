import type { AuditFilters } from "./audit-logs-data";

type SettingsValues = {
  name: string;
  domains: readonly string[];
  domainRestrictionsEnabled: boolean;
  desktopVersions: readonly string[];
};

export function settingsDraftChanged(saved: SettingsValues, draft: SettingsValues, options: { compareVersions: boolean }): boolean {
  return saved.name !== draft.name.trim()
    || saved.domainRestrictionsEnabled !== draft.domainRestrictionsEnabled
    || !sameStringSet(normalizeAllowedEmailDomainsInput(saved.domains.join("\n")) ?? [], draft.domainRestrictionsEnabled ? draft.domains : [])
    || (options.compareVersions && !sameStringSet(saved.desktopVersions, draft.desktopVersions));
}

export function auditLocalDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Dates stay in the draft until both endpoints are valid. Never serialize an invalid date. */
export function auditFiltersFromDraft(draft: AuditFilters): AuditFilters | null {
  const { from, to } = draft;
  if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))
    || (from && to && Date.parse(from) > Date.parse(to))) return null;
  return { ...draft, searchId: draft.searchId?.trim() || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined };
}

export function pendingAuditSearch(immediate: boolean, draft: AuditFilters, appliedSearchId?: string): AuditFilters | null {
  if (!immediate || (draft.searchId?.trim() || undefined) === appliedSearchId) return null;
  return auditFiltersFromDraft(draft);
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}

export function normalizeAllowedEmailDomainsInput(value: string): string[] | null {
  const domains = [...new Set(value.split(/[\s,]+/).map((entry) => entry.trim().toLowerCase().replace(/^@+/, "")).filter(Boolean))];
  return domains.length > 0 ? domains : null;
}

/** A refresh replaces untouched values, never an unsaved edit. Organization switches always reset. */
export function refreshedDraft<T>(current: T, previous: T | undefined, next: T, sameOrganization: boolean,
  equal: (left: T, right: T) => boolean = Object.is): T {
  return !sameOrganization || previous === undefined || equal(current, previous) ? next : current;
}
