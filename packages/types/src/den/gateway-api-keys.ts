import { z } from "zod";

/**
 * AI Gateway API keys for 3rd party tools.
 *
 * An organization admin turns the setting on in Settings › General › AI Gateway. Members can then create
 * their own named Gateway keys and call the Gateway's provider-less endpoints from any tool or harness.
 * A key only ever reaches the models its member's grants allow. Turning the setting off stops every member
 * key at the Gateway at once; the keys are kept and work again when it is turned back on.
 */
export const organizationAiGatewaySettingsSchema = z.object({
  /** Members may create their own API keys and use the Gateway from 3rd party tools and harnesses. */
  memberApiKeys: z.boolean(),
});

export type OrganizationAiGatewaySettings = z.infer<typeof organizationAiGatewaySettingsSchema>;

/** Off until an admin turns it on. */
export const DEFAULT_ORGANIZATION_AI_GATEWAY_SETTINGS: OrganizationAiGatewaySettings = { memberApiKeys: false };

/** Organization metadata key holding the setting. */
export const ORGANIZATION_AI_GATEWAY_SETTINGS_KEY = "aiGateway";

/** Most active keys one member may hold at once. */
export const GATEWAY_API_KEY_MEMBER_LIMIT = 20;

export const GATEWAY_API_KEY_NAME_MAX_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (isRecord(metadata)) return metadata;
  if (typeof metadata !== "string") return null;
  // Some readers hand back the stored JSON column text.
  try {
    const parsed: unknown = JSON.parse(metadata);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readOrganizationAiGatewaySettings(metadata: unknown): OrganizationAiGatewaySettings {
  const stored = metadataRecord(metadata)?.[ORGANIZATION_AI_GATEWAY_SETTINGS_KEY];
  if (!isRecord(stored)) return { ...DEFAULT_ORGANIZATION_AI_GATEWAY_SETTINGS };
  return { memberApiKeys: stored.memberApiKeys === true };
}

export function withOrganizationAiGatewaySettings(
  metadata: Record<string, unknown> | null | undefined,
  settings: Partial<OrganizationAiGatewaySettings>,
): Record<string, unknown> {
  const stored = metadataRecord(metadata)?.[ORGANIZATION_AI_GATEWAY_SETTINGS_KEY];
  const current = isRecord(stored) ? stored : {};
  return { ...(metadata ?? {}), [ORGANIZATION_AI_GATEWAY_SETTINGS_KEY]: { ...current, ...readOrganizationAiGatewaySettings(metadata), ...settings } };
}

export const gatewayApiKeyNameSchema = z.string().trim().min(1).max(GATEWAY_API_KEY_NAME_MAX_LENGTH);

/** Expiry choices offered when creating a key, in days; null never expires. */
export const GATEWAY_API_KEY_EXPIRY_CHOICES = [7, 30, 90, 365, null] as const;
export type GatewayApiKeyExpiryChoice = (typeof GATEWAY_API_KEY_EXPIRY_CHOICES)[number];
export const DEFAULT_GATEWAY_API_KEY_EXPIRY: GatewayApiKeyExpiryChoice = 90;

/** True once a key's expiry has passed. */
export function gatewayApiKeyExpired(expiresAt: string | Date | null, now: number = Date.now()): boolean {
  if (expiresAt === null) return false;
  const time = new Date(expiresAt).getTime();
  return !Number.isNaN(time) && time <= now;
}

/** A member's own key as listed to them. The secret is only ever returned once, when the key is created. */
export const gatewayApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The first characters of the key, to tell keys apart. */
  prefix: z.string(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  /** When the key stops working; null never expires. A past time means the key has expired. */
  expiresAt: z.string().datetime().nullable(),
});

export type GatewayApiKey = z.infer<typeof gatewayApiKeySchema>;

/** An organization's key as listed to admins, with the member it belongs to. */
export const organizationGatewayApiKeySchema = gatewayApiKeySchema.extend({
  member: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});

export type OrganizationGatewayApiKey = z.infer<typeof organizationGatewayApiKeySchema>;

export const createdGatewayApiKeySchema = z.object({
  apiKey: gatewayApiKeySchema,
  /** The full key. Shown once; Den keeps only a digest. */
  key: z.string(),
});

export type CreatedGatewayApiKey = z.infer<typeof createdGatewayApiKeySchema>;

/** What a member needs to set up a tool: whether they may use keys, and where to point it. */
export const memberGatewayApiKeysViewSchema = z.object({
  /** The organization allows member keys (the admin setting). */
  enabled: z.boolean(),
  /** The Gateway URL tools call, e.g. https://gateway.example.com/api/v1. */
  baseUrl: z.string(),
  apiKeys: z.array(gatewayApiKeySchema),
});

export type MemberGatewayApiKeysView = z.infer<typeof memberGatewayApiKeysViewSchema>;

export const organizationGatewayApiKeysViewSchema = z.object({
  enabled: z.boolean(),
  apiKeys: z.array(organizationGatewayApiKeySchema),
});

export type OrganizationGatewayApiKeysView = z.infer<typeof organizationGatewayApiKeysViewSchema>;
