import type { DenExternalMcpConnection } from "@/app/lib/den";
import { readDenSettings } from "@/app/lib/den";
import { DASHBOARD_TILE_ACCESS_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import { forgetMcpAppOpenLoads } from "@/app/lib/mcp-app-open-loads";
import { clearMcpAppResults } from "@/app/lib/mcp-app-result-cache";
import type { ActivityScope } from "@/react-app/kernel/activity-types";
import type { ConnectCapabilityInventory } from "../session/surface/connect-capability-inventory";
import { clearDashboardTileData } from "./dashboard-tile-cache";

type MemberInventory = {
  capabilities: Pick<ConnectCapabilityInventory, "plugins">;
  connections: DenExternalMcpConnection[];
};
type RecordedAccess = { revision: string | null; access: string[] };

const CHECK_WAIT_MS = 250;

let currentMember: ActivityScope | null = null;
let comparedMember: string | null = null;
let checking: Promise<void> | null = null;

const memberKey = (scope: ActivityScope) => JSON.stringify([scope.baseUrl, scope.organizationId, scope.memberId]);
const storageKey = (scope: ActivityScope) => `${DASHBOARD_TILE_ACCESS_STORAGE_PREFIX}${memberKey(scope)}`;

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
  }
}

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

export function setMemberAccessScope(scope: ActivityScope | null): void {
  if (!scope || !currentMember || memberKey(scope) !== memberKey(currentMember)) comparedMember = null;
  currentMember = scope;
}

export function noteInventoryRevision(scope: ActivityScope, revision: string | null): void {
  if (revision !== null && readRecordedAccess(scope)?.revision === revision) comparedMember = memberKey(scope);
}

export function reconcileMemberAccess(scope: ActivityScope, revision: string | null, inventory: MemberInventory): void {
  const access = memberAccessKeys(inventory);
  const previous = readRecordedAccess(scope);
  if (previous?.access.some((key) => !access.includes(key))) clearStoredMcpAppData();
  recordAccess(scope, { revision, access });
  comparedMember = memberKey(scope);
}

export function trackMemberAccessCheck(check: Promise<unknown>): void {
  const settled: Promise<void> = check.then(() => undefined, () => undefined).finally(() => {
    if (checking === settled) checking = null;
  });
  checking = settled;
}

export function memberAccessConfirmed(): boolean {
  return currentMember !== null && comparedMember === memberKey(currentMember)
    && currentMember.organizationId === readDenSettings().activeOrgId;
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

export function resetMemberAccessSession(): void {
  currentMember = null;
  comparedMember = null;
  checking = null;
}
