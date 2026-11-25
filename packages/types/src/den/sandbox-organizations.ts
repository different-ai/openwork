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
  connectorBaseUrl: z.url({ protocol: /^https?$/ }).max(1900).nullable(),
  days: z.number().int().min(1).max(SANDBOX_MAX_DAYS),
  memberLimit: z.number().int().min(1).max(SANDBOX_MAX_MEMBERS),
  allowedEmailDomains: z.array(domainSchema).max(20),
  joinRole: sandboxJoinRoleSchema.optional(),
  creditUsd: creditUsdSchema.optional(),
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
  sampleMicrosoft365: z.boolean().optional(),
  sampleSlack: z.boolean().optional(),
  modelProviderCount: z.number().int().optional(),
  planTier: z.enum(["free", "team", "enterprise"]).optional(),
  modelCredit: z.object({ limitUsd: z.number(), remainingUsd: z.number().nullable() }).nullable().optional(),
  allowedEmailDomains: z.array(z.string()),
  joinRole: sandboxJoinRoleSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

/** What a new sandbox gets on this deployment. Older servers omit it. */
export const sandboxDefaultsSchema = z.object({
  workplaceUrl: z.string().nullable(),
  gatewayModels: z.array(z.string()),
  gatewayProviderId: z.string().nullable(),
  creditUsd: z.number().nullable().optional(),
  modelChoice: z.boolean().optional(),
});

/** The models a new sandbox can be given: the sandbox provider's catalog models the AI Gateway supports. */
export const sandboxModelOptionsSchema = z.object({
  providerId: z.string(),
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
