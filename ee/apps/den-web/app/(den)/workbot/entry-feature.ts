import { joinBaseUrl, readBaseUrlEnv } from "@openwork/types/url";
import { z } from "zod";

const enabledResponse = z.object({
  version: z.literal(1),
  deployment: z.literal("self_hosted"),
  features: z.object({ workbotConfiguredEntry: z.literal(true) }),
});

export async function configuredWorkbotEntryEnabled(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.DEN_DEPLOYMENT?.trim() !== "self_hosted" || env.DEN_WORKBOT_URL?.trim()) return false;
  try {
    const base = readBaseUrlEnv(env, "DEN_API_BASE");
    if (!base) return false;
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    const response = await fetch(joinBaseUrl(base, "/v1/features"), {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    return enabledResponse.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}
