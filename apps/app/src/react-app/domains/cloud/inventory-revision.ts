import { createDenClient, readDenSettings } from "@/app/lib/den";

/**
 * Den's inventory revision changes whenever what members of the organization
 * can use may have changed (providers, plugins, marketplaces, connections,
 * teams, access, feature flags or a deploy). Cloud syncs that run when the app
 * regains focus or on a timer read it first and skip the reload when it still
 * matches the revision of their last successful sync, so a quiet organization
 * costs one small request instead of the whole inventory.
 */

/** Reload anyway after this long, so a change Den could not attribute still arrives. */
export const INVENTORY_FULL_SYNC_MAX_AGE_MS = 15 * 60_000;

/** Several syncs wake up on the same focus event; they share one revision read. */
const SHARED_READ_MS = 5_000;

let shared: { key: string; at: number; read: Promise<string | null> } | null = null;

/** The signed-in member's organization revision, or null when there is none or Den cannot tell. */
export function readInventoryRevision(now = Date.now()): Promise<string | null> {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const organizationId = settings.activeOrgId?.trim() ?? "";
  if (!token || !organizationId) return Promise.resolve(null);
  const key = `${settings.baseUrl}\n${organizationId}\n${token}`;
  if (shared && shared.key === key && now - shared.at < SHARED_READ_MS) return shared.read;
  const read = createDenClient({ baseUrl: settings.baseUrl, token })
    .getInventoryRevision(organizationId)
    .catch(() => null);
  shared = { key, at: now, read };
  return read;
}

export type InventoryRevisionGate = {
  /** Reads the revision; `skip` is true when the last successful sync already saw it. */
  check: () => Promise<{ skip: boolean; revision: string | null }>;
  /** Records the revision read before a sync that has now succeeded. */
  synced: (revision: string | null) => void;
};

export function createInventoryRevisionGate(input?: {
  read?: () => Promise<string | null>;
  now?: () => number;
  maxAgeMs?: number;
}): InventoryRevisionGate {
  const read = input?.read ?? (() => readInventoryRevision());
  const now = input?.now ?? Date.now;
  const maxAgeMs = input?.maxAgeMs ?? INVENTORY_FULL_SYNC_MAX_AGE_MS;
  let last: { revision: string; at: number } | null = null;
  return {
    async check() {
      const revision = await read();
      const skip = revision !== null && last !== null && last.revision === revision && now() - last.at < maxAgeMs;
      return { skip, revision };
    },
    synced(revision) {
      last = revision === null ? null : { revision, at: now() };
    },
  };
}
