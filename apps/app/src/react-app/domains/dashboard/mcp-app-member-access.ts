import type { DenExternalMcpConnection } from "@/app/lib/den";
import { readDenSettings } from "@/app/lib/den";
import { DASHBOARD_TILE_ACCESS_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import { forgetMcpAppOpenLoads } from "@/app/lib/mcp-app-open-loads";
import { clearMcpAppResults } from "@/app/lib/mcp-app-result-cache";
import type { ActivityScope } from "@/react-app/kernel/activity-types";
import type { ConnectCapabilityInventory } from "../session/surface/connect-capability-inventory";
import { clearDashboardTileData } from "./dashboard-tile-cache";

/**
 * What an App last showed stays on this device so it can reopen at once, so it
 * has to go when the person loses the access that produced it. Den's inventory
 * revision changes for many reasons, so a change only prompts a comparison of
 * what this member can use, and stored data clears when something was lost.
 * The revision is a best-effort signal: this clears data, it never proves
 * access. Until this session has compared, a saved tile withholds stored reads.
 */
type MemberInventory = {
  capabilities: Pick<ConnectCapabilityInventory, "plugins">;
  connections: DenExternalMcpConnection[];
};
type RecordedAccess = { revision: string | null; access: string[] };

/** How long a saved tile waits for a check under way before opening without stored reads. */
const CHECK_WAIT_MS = 250;

/** The organization this session has compared access for. */
let comparedOrganization: string | null = null;
let checking: Promise<void> | null = null;

const storageKey = (scope: ActivityScope) =>
  `${DASHBOARD_TILE_ACCESS_STORAGE_PREFIX}${JSON.stringify([scope.baseUrl, scope.organizationId, scope.memberId])}`;

function readRecordedAccess(scope: ActivityScope): RecordedAccess | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(scope)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { revision, access } = value as Record<string, unknown>;
    if ((typeof revision !== "string" && revision !== null) || !Array.isArray(access)
      || !access.every((key) => typeof key === "string")) return null;
    return { revision, access };
  } catch {
    return null;
  }
}

function recordAccess(scope: ActivityScope, recorded: RecordedAccess) {
  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify(recorded));
  } catch {
    // Without a record the next session has nothing to compare, and clears nothing.
  }
}

/** One entry per thing this member can use, naming the account behind a connection. */
export function memberAccessKeys({ capabilities, connections }: MemberInventory): string[] {
  const usable = connections.filter((connection) => connection.connected
    && (connection.credentialMode === "shared" || connection.connectedForMe)
    && !connection.needsReconnect && connection.credentialHealth !== "reconnect_required");
  return [...new Set([
    ...usable.flatMap((connection) => {
      const account = `connection:${connection.id}:${connection.externalAccountId ?? ""}:${connection.tenantId ?? ""}`;
      return [account, ...(connection.grantedScopes ?? []).map((scope) => `${account}:${scope}`)];
    }),
    ...capabilities.plugins.map((plugin) => `plugin:${plugin.pluginId}`),
  ])].sort();
}

function clearStoredMcpAppData() {
  clearDashboardTileData();
  clearMcpAppResults();
  forgetMcpAppOpenLoads();
}

/** A revision this member's access was already compared at means nothing has changed since. */
export function noteInventoryRevision(scope: ActivityScope, revision: string | null): void {
  if (revision !== null && readRecordedAccess(scope)?.revision === revision) comparedOrganization = scope.organizationId;
}

/** Compares a complete inventory with the last one, clearing stored data if anything was lost. */
export function reconcileMemberAccess(scope: ActivityScope, revision: string | null, inventory: MemberInventory): void {
  const access = memberAccessKeys(inventory);
  const previous = readRecordedAccess(scope);
  if (previous?.access.some((key) => !access.includes(key))) clearStoredMcpAppData();
  recordAccess(scope, { revision, access });
  comparedOrganization = scope.organizationId;
}

export function trackMemberAccessCheck(check: Promise<unknown>): void {
  const settled: Promise<void> = check.then(() => undefined, () => undefined).finally(() => {
    if (checking === settled) checking = null;
  });
  checking = settled;
}

/** Whether this member's access has been compared in this session, so stored reads may show. */
export function memberAccessConfirmed(): boolean {
  return comparedOrganization !== null && comparedOrganization === readDenSettings().activeOrgId;
}

export function memberAccessCheckPending(): boolean {
  return checking !== null && !memberAccessConfirmed();
}

export async function waitForMemberAccessCheck(): Promise<void> {
  if (!checking || memberAccessConfirmed()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([checking, new Promise<void>((resolve) => { timer = setTimeout(resolve, CHECK_WAIT_MS); })]);
  clearTimeout(timer);
}

/** For tests: a new session has compared nothing yet. */
export function resetMemberAccessSession(): void {
  comparedOrganization = null;
  checking = null;
}
