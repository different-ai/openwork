import { createDenClient, readDenSettings } from "@/app/lib/den";

export const INVENTORY_FULL_SYNC_MAX_AGE_MS = 15 * 60_000;

const SHARED_READ_MS = 5_000;

let shared: { key: string; at: number; read: Promise<string | null> } | null = null;

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
  check: () => Promise<{ skip: boolean; revision: string | null }>;
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
