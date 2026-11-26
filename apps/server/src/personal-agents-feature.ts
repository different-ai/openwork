import { createHash } from "node:crypto";
import { z } from "zod";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";

const CACHE_TTL_MS = 60_000;
const DEN_TIMEOUT_MS = 3_500;
const orgFeaturesSchema = z.object({ features: z.object({ personalAgents: z.literal(true) }) });

type DenFetch = (url: string, init: RequestInit) => Promise<Response>;

async function readPersonalAgentsFeature(fetchDen: DenFetch, session: CloudProviderDenSession): Promise<boolean> {
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
      return false;
    }
    return orgFeaturesSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

export function createPersonalAgentsFeatureLookup(fetchDen: DenFetch, now = () => performance.now()) {
  const cache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();
  return async (session: CloudProviderDenSession | null): Promise<boolean> => {
    if (!session) return false;
    const at = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key);
    }
    const key = createHash("sha256").update(JSON.stringify([session.baseUrl, session.orgId, session.token])).digest("hex");
    const cached = cache.get(key);
    if (cached) return cached.result;
    const entry = { expiresAt: Infinity, result: readPersonalAgentsFeature(fetchDen, session) };
    cache.set(key, entry);
    const enabled = await entry.result;
    entry.expiresAt = now() + CACHE_TTL_MS;
    return enabled;
  };
}
