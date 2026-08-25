/**
 * Organization-granted dashboard tiles and their per-user launch consent.
 *
 * Granted dashboards arrive from Den as plain element references. The consent
 * model stays exactly the local one: a grant never bypasses launch approval,
 * write-tools stay run-on-request, and auto-launch is only unlocked after this
 * user has run the tile manually once. That consent is therefore stored
 * locally per user and organization, never on the org dashboard.
 */
import type { DenDashboardElement, DenGrantedDashboard } from "@/app/lib/den";
import type { DashboardMcpAppEntry } from "./dashboard-store";

const CONSENT_STORAGE_PREFIX = "openwork.react.dashboardGrantedConsent.v1";

export type GrantedTileConsent = {
  autoLaunch?: boolean;
  launchApproved?: boolean;
};

export type GrantedConsentMap = Record<string, GrantedTileConsent>;

export function grantedConsentScopeKey(userId: string | null, organizationId: string | null): string {
  return `${CONSENT_STORAGE_PREFIX}.${userId?.trim() || "local"}.${organizationId?.trim() || "none"}`;
}

// Canonical JSON (sorted object keys) so the consent fingerprint is stable
// across property-order differences in the wire payload.
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// FNV-1a over the element's material launch fields.
function consentFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Consent identity for a granted element. Every field that changes what a
 * launch actually invokes (connection, tool, resource, launch arguments) is
 * part of the id, so an admin edit to any of them discards this user's stored
 * approval and auto-launch — the changed app must be run manually again.
 */
export function grantedEntryId(dashboardId: string, element: DenDashboardElement): string {
  const material = canonicalize({
    serverName: element.serverName,
    connectionId: element.connectionId ?? null,
    toolName: element.toolName,
    projectedToolName: element.projectedToolName,
    resourceUri: element.resourceUri,
    launchArguments: element.launchArguments ?? null,
  });
  return `granted:${dashboardId}:mcp:${element.serverName}:${element.toolName}:${consentFingerprint(material)}`;
}

/** A granted element as an ordinary dashboard entry, with this user's consent applied. */
export function grantedDashboardEntry(
  dashboard: DenGrantedDashboard,
  element: DenDashboardElement,
  consent: GrantedTileConsent | undefined,
): DashboardMcpAppEntry {
  return {
    kind: "mcp",
    id: grantedEntryId(dashboard.id, element),
    serverName: element.serverName,
    ...(element.connectionId ? { connectionId: element.connectionId } : {}),
    toolName: element.toolName,
    projectedToolName: element.projectedToolName,
    resourceUri: element.resourceUri,
    title: element.title,
    ...(element.launchArguments ? { launchArguments: element.launchArguments } : {}),
    ...(consent?.autoLaunch === true ? { autoLaunch: true } : {}),
    ...(element.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(consent?.launchApproved === true ? { launchApproved: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readGrantedConsent(scopeKey: string): GrantedConsentMap {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(scopeKey);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const consent: GrantedConsentMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const entry: GrantedTileConsent = {
        ...(value.autoLaunch === true ? { autoLaunch: true } : {}),
        ...(value.launchApproved === true ? { launchApproved: true } : {}),
      };
      if (entry.autoLaunch || entry.launchApproved) consent[id] = entry;
    }
    return consent;
  } catch {
    return {};
  }
}

export function writeGrantedConsent(scopeKey: string, consent: GrantedConsentMap) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(scopeKey, JSON.stringify(consent));
  } catch {
    // Persistence is best-effort; in-memory consent still applies this session.
  }
}
