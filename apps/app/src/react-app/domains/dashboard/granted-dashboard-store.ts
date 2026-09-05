/**
 * Organization-granted dashboard tiles and their per-user launch consent.
 *
 * Granted dashboards arrive from Den as plain element references. The consent
 * model never treats provider metadata as user authorization: safe-looking
 * tools run automatically only after a successful user-initiated launch,
 * while approval-gated tools stay run-on-request. Consent is stored locally
 * per user and organization, never on the org dashboard.
 */
import type { DenDashboardElement, DenGrantedDashboard } from "@/app/lib/den";

export type DashboardMcpAppEntry = {
  kind: "mcp";
  id: string;
  serverName: string;
  /** Present for Connect app-host apps: launch them through this connection reference. */
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string;
  /** Launch arguments selected by the organization administrator. */
  launchArguments?: Record<string, unknown>;
  /** Write-capable apps remain manual-only. */
  requiresApproval?: boolean;
  /** Server-authored admin policy to run this exact managed element automatically. */
  organizationAutoLaunch?: boolean;
  /** The member's locally stored approval for this exact managed element. */
  launchApproved?: boolean;
  /** The member enabled automatic launch by successfully running this exact safe element. */
  autoLaunch?: boolean;
};

const CONSENT_STORAGE_PREFIX = "openwork.react.dashboardGrantedConsent.v1";

export type GrantedTileConsent = {
  launchApproved?: boolean;
  autoLaunch?: boolean;
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

/**
 * Consent identity for a granted element. Every field that changes what a
 * launch invokes or how it must be approved is part of the id — encoded
 * losslessly, not hashed, so no crafted admin edit can collide with a prior
 * identity — and an edit to any of them discards this user's stored approval
 * and auto-launch: the changed app must be run manually again.
 */
export function grantedEntryId(dashboardId: string, element: DenDashboardElement): string {
  const material = canonicalize({
    serverName: element.serverName,
    connectionId: element.connectionId ?? null,
    toolName: element.toolName,
    projectedToolName: element.projectedToolName,
    resourceUri: element.resourceUri,
    launchArguments: element.launchArguments ?? null,
    requiresApproval: element.requiresApproval === true,
    organizationAutoLaunch: element.organizationAutoLaunch === true,
  });
  return `granted:${dashboardId}:mcp:${encodeURIComponent(material)}`;
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
    ...(element.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(element.organizationAutoLaunch === true ? { organizationAutoLaunch: true } : {}),
    ...(consent?.launchApproved === true ? { launchApproved: true } : {}),
    ...(element.requiresApproval !== true
      && consent?.autoLaunch === true
      && consent.launchApproved !== true
      ? { autoLaunch: true }
      : {}),
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
        ...(value.launchApproved === true ? { launchApproved: true } : {}),
        ...(value.autoLaunch === true ? { autoLaunch: true } : {}),
      };
      if (entry.launchApproved || entry.autoLaunch) consent[id] = entry;
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
