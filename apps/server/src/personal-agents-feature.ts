import { createHash } from "node:crypto";
import { z } from "zod";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";

const CACHE_TTL_MS = 60_000;
const DEN_TIMEOUT_MS = 3_500;
const orgFeaturesSchema = z.object({ features: z.object({ personalAgents: z.boolean().optional() }).optional() });

type DenFetch = (url: string, init: RequestInit) => Promise<Response>;
type Entry = { enabled: boolean; expiresAt: number; pending?: Promise<boolean> };

async function readPersonalAgentsFeature(fetchDen: DenFetch, session: CloudProviderDenSession): Promise<boolean | undefined> {
  try {
    const response = await fetchDen(`${session.baseUrl}/v1/org`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.token}`,
        "x-openwork-org-id": session.orgId,
        "x-openwork-legacy-org-id": session.orgId,
      },
      redirect: "error",
      signal: AbortSignal.timeout(DEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const parsed = orgFeaturesSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.features?.personalAgents === true : undefined;
  } catch {
    return undefined;
  }
}

export function createPersonalAgentsFeatureLookup(fetchDen: DenFetch, now = () => performance.now()) {
  const cache = new Map<string, Entry>();

  function entryFor(session: CloudProviderDenSession): Entry {
    const key = createHash("sha256").update(JSON.stringify([session.baseUrl, session.orgId, session.token])).digest("hex");
    const existing = cache.get(key);
    if (existing) return existing;
    const entry = { enabled: false, expiresAt: -Infinity };
    cache.set(key, entry);
    return entry;
  }

  function refresh(session: CloudProviderDenSession, entry: Entry): Promise<boolean> | undefined {
    if (entry.pending || entry.expiresAt > now()) return entry.pending;
    entry.pending = readPersonalAgentsFeature(fetchDen, session).then((enabled) => {
      entry.enabled = enabled ?? entry.enabled;
      entry.expiresAt = now() + CACHE_TTL_MS;
      entry.pending = undefined;
      return entry.enabled;
    });
    return entry.pending;
  }

  return {
    cached(session: CloudProviderDenSession | null): boolean {
      if (!session) return false;
      const entry = entryFor(session);
      void refresh(session, entry);
      return entry.enabled;
    },
    async check(session: CloudProviderDenSession | null): Promise<boolean> {
      if (!session) return false;
      const entry = entryFor(session);
      return refresh(session, entry) ?? entry.enabled;
    },
  };
}
