import { z } from "zod";

/** The fictional workplace apps a sandbox connects, each served at `<connectorBaseUrl>/<key>/mcp`. */
export const SANDBOX_WORKPLACE_APPS = [
  { key: "outlook", name: "Outlook" },
  { key: "calendar", name: "Calendar" },
  { key: "drive", name: "Drive" },
  { key: "jira", name: "Jira" },
  { key: "confluence", name: "Confluence" },
] as const;

export const SANDBOX_MAX_DAYS = 90;
export const SANDBOX_MAX_MEMBERS = 500;
/** Highest model credit, in US dollars, one sandbox's own model key can be capped at. */
export const SANDBOX_MAX_CREDIT_USD = 5000;
/** Most AI Gateway models one sandbox can be created with. */
export const SANDBOX_MAX_MODELS = 20;

const creditUsdSchema = z.number().int().min(1).max(SANDBOX_MAX_CREDIT_USD);

/** What people who join with the link become. Owners stay owners. New sandboxes default to super-admin. */
export const sandboxJoinRoleSchema = z.enum(["member", "admin", "super-admin"]);
export type SandboxJoinRole = z.infer<typeof sandboxJoinRoleSchema>;

const domainSchema = z.string().trim().toLowerCase().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Enter a domain such as example.com.");

export const sandboxCreateInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** Workplace service root; null creates the organization without connectors. */
  connectorBaseUrl: z.url({ protocol: /^https?$/ }).max(1900).nullable(),
  days: z.number().int().min(1).max(SANDBOX_MAX_DAYS),
  memberLimit: z.number().int().min(1).max(SANDBOX_MAX_MEMBERS),
  /** Empty means anyone with the link can join. */
  allowedEmailDomains: z.array(domainSchema).max(20),
  /** Omitted means super-admin. */
  joinRole: sandboxJoinRoleSchema.optional(),
  /**
   * Spending cap for the sandbox's own model key, when the deployment mints one per sandbox. Omitted uses the
   * deployment default; ignored when every sandbox shares the deployment's key.
   */
  creditUsd: creditUsdSchema.optional(),
  /**
   * AI Gateway models this sandbox gets, as ids in the deployment's sandbox provider catalog. Omitted uses the
   * deployment's list. Needs `sandboxModelChoice` on and a sandbox model key on the deployment.
   */
  modelIds: z.array(z.string().trim().min(1).max(200)).min(1).max(SANDBOX_MAX_MODELS).optional(),
}).strict();

/** Sets the sandbox model key's total cap (not an increment). */
export const sandboxCreditInputSchema = z.object({ creditUsd: creditUsdSchema }).strict();

export const sandboxJoinRoleInputSchema = z.object({ joinRole: sandboxJoinRoleSchema }).strict();

export const sandboxExtendInputSchema = z.object({ days: z.number().int().min(1).max(SANDBOX_MAX_DAYS) }).strict();

export const sandboxStateSchema = z.enum(["open", "expired", "closed"]);

export const sandboxSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  state: sandboxStateSchema,
  joinLink: z.url(),
  memberCount: z.number().int(),
  memberLimit: z.number().int(),
  connectorBaseUrl: z.string().nullable(),
  connectorCount: z.number().int(),
  /** Outlook, Calendar and Drive come as one Microsoft 365 connector Workbot can use (sandboxMicrosoft365). Older servers omit it. */
  sampleMicrosoft365: z.boolean().optional(),
  /** The sandbox has the sample Slack with the Workbot Slack app installed. Older servers omit it. */
  sampleSlack: z.boolean().optional(),
  /** AI Gateway providers in the sandbox organization. Older servers omit it. */
  modelProviderCount: z.number().int().optional(),
  /** The organization's plan tier; sandboxes are created on Enterprise. Older servers omit it. */
  planTier: z.enum(["free", "team", "enterprise"]).optional(),
  /**
   * The sandbox's own model key: its cap and what is left, in US dollars. remainingUsd is null when the
   * provider could not be reached. null when the sandbox has no key of its own. Older servers omit it.
   */
  modelCredit: z.object({ limitUsd: z.number(), remainingUsd: z.number().nullable() }).nullable().optional(),
  allowedEmailDomains: z.array(z.string()),
  joinRole: sandboxJoinRoleSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

/** What a new sandbox gets on this deployment. Older servers omit it. */
export const sandboxDefaultsSchema = z.object({
  /** Workshop service the sample work apps use; null when none is configured. */
  workplaceUrl: z.string().nullable(),
  /** Models every member gets through the AI Gateway; empty when no sandbox key is configured. */
  gatewayModels: z.array(z.string()),
  gatewayProviderId: z.string().nullable(),
  /** Default cap for each sandbox's own model key; null when sandboxes share the deployment's key. Older servers omit it. */
  creditUsd: z.number().nullable().optional(),
  /** Whether a new sandbox's models can be chosen (`modelIds`); otherwise it gets gatewayModels. Older servers omit it. */
  modelChoice: z.boolean().optional(),
});

/** The models a new sandbox can be given: the sandbox provider's catalog models the AI Gateway supports. */
export const sandboxModelOptionsSchema = z.object({
  providerId: z.string(),
  /** False when the provider's catalog could not be read; model ids can still be sent and are checked on create. */
  available: z.boolean(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const sandboxListSchema = z.object({
  enabled: z.boolean(),
  sandboxes: z.array(sandboxSchema),
  defaults: sandboxDefaultsSchema.optional(),
});

export const sandboxCreatedSchema = z.object({ sandbox: sandboxSchema });

export const sandboxJoinPreviewSchema = z.object({
  organizationName: z.string(),
  state: sandboxStateSchema.or(z.literal("full")),
  /** Older servers omit it; then people join as members. */
  joinRole: sandboxJoinRoleSchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }),
  connectors: z.array(z.string()),
});

export const sandboxJoinedSchema = z.object({ organizationId: z.string(), alreadyMember: z.boolean() });

export type SandboxCreateInput = z.infer<typeof sandboxCreateInputSchema>;
export type SandboxExtendInput = z.infer<typeof sandboxExtendInputSchema>;
export type SandboxCreditInput = z.infer<typeof sandboxCreditInputSchema>;
export type Sandbox = z.infer<typeof sandboxSchema>;
export type SandboxState = z.infer<typeof sandboxStateSchema>;
export type SandboxList = z.infer<typeof sandboxListSchema>;
export type SandboxDefaults = z.infer<typeof sandboxDefaultsSchema>;
export type SandboxModelOptions = z.infer<typeof sandboxModelOptionsSchema>;
export type SandboxJoinPreview = z.infer<typeof sandboxJoinPreviewSchema>;
