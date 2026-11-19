import { z } from "zod";
import {
  getAiGatewayProviderRoute,
  getLlmProviderRoute,
  getMarketplaceRoute,
  getMcpConnectionRoute,
  getPluginSkillRoute,
} from "../../../_lib/den-org";

export type DashboardActivityEntry = {
  id: string;
  kind: "connection" | "skill" | "plugin" | "provider";
  title: string;
  detail: string;
  occurredAt: string;
  href: string;
  action: "Open" | "Browse";
  logo?: { name: string; url?: string; providerId?: string };
};

export const DASHBOARD_ACTIVITY_PATH = "/v1/org/activity";

const labelSchema = z.string().trim().min(1);
const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connection"), connectionId: labelSchema }),
  z.object({ type: z.literal("llm_provider"), llmProviderId: labelSchema }),
  z.object({ type: z.literal("gateway_provider"), inferenceProviderId: labelSchema }),
  z.object({ type: z.literal("marketplace"), marketplaceId: labelSchema }),
  z.object({ type: z.literal("skill"), pluginId: labelSchema, skillId: labelSchema }),
]);
const entrySchema = z.object({
  id: labelSchema,
  kind: z.enum(["connection", "skill", "plugin", "provider"]),
  title: labelSchema,
  detail: labelSchema,
  // Den returns only stored creation/version dates, never updatedAt or now.
  occurredAt: z.string().datetime({ offset: true }),
  target: targetSchema,
  logo: z.object({ name: labelSchema, url: z.string().optional(), providerId: z.string().optional() }).optional(),
});
const responseSchema = z.object({ activity: z.array(entrySchema) });

export type ActivityRequest = (path: string, signal: AbortSignal) => Promise<unknown>;

export type DashboardActivityInput = {
  orgSlug: string | null;
  signal: AbortSignal;
  request: ActivityRequest;
};

const ACTIVITY_LIMIT = 5;

function hrefFor(orgSlug: string | null, target: z.infer<typeof targetSchema>): string {
  switch (target.type) {
    case "connection": return getMcpConnectionRoute(orgSlug, target.connectionId);
    case "llm_provider": return getLlmProviderRoute(orgSlug, target.llmProviderId);
    case "gateway_provider": return getAiGatewayProviderRoute(orgSlug, target.inferenceProviderId);
    case "marketplace": return getMarketplaceRoute(orgSlug, target.marketplaceId);
    case "skill": return getPluginSkillRoute(orgSlug, target.pluginId, target.skillId);
  }
}

/**
 * Den computes the newest five entries in one request; the web only builds
 * destinations. A recoverable snapshot of existing resources, not an audit log.
 */
export async function fetchDashboardActivity(input: DashboardActivityInput): Promise<DashboardActivityEntry[]> {
  input.signal.throwIfAborted();
  const { activity } = responseSchema.parse(await input.request(DASHBOARD_ACTIVITY_PATH, input.signal));
  input.signal.throwIfAborted();
  return activity.slice(0, ACTIVITY_LIMIT).map(({ target, logo, ...entry }) => ({
    ...entry,
    href: hrefFor(input.orgSlug, target),
    action: target.type === "marketplace" ? "Browse" : "Open",
    ...(logo ? { logo } : {}),
  }));
}
