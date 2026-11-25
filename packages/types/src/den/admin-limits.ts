import { z } from "zod";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function normalizeEmailIdentity(email: string): string | null {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  let local = value.slice(0, at).split("+")[0] ?? "";
  let domain = value.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.replaceAll(".", "");
  }
  if (!local || !domain.includes(".")) return null;
  return `${local}@${domain}`;
}

export function normalizeEmailDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^@/, "");
  const domain = trimmed.includes("@") ? normalizeEmailIdentity(trimmed)?.split("@")[1] : trimmed;
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return GMAIL_DOMAINS.has(domain) ? "gmail.com" : domain;
}

export const ADMIN_LIMIT_KINDS = [
  { key: "workspace-creation", label: "Workspace creation", description: "How many workspaces one person can have at once. Deleting one frees a slot." },
] as const;
export type AdminLimitKind = typeof ADMIN_LIMIT_KINDS[number]["key"];

export const workspaceLimitRuleScopeSchema = z.enum(["email", "domain"]);
export type WorkspaceLimitRuleScope = z.infer<typeof workspaceLimitRuleScopeSchema>;

export const workspaceLimitRuleSchema = z.object({
  id: z.string(),
  scope: workspaceLimitRuleScopeSchema,
  value: z.string().describe("Normalized email address or domain."),
  limit: z.number().int().positive().nullable().describe("Workspaces each matching person can create. Null means no limit."),
  updatedAt: z.iso.datetime(),
});
export type WorkspaceLimitRule = z.infer<typeof workspaceLimitRuleSchema>;

export const workspaceLimitSettingsSchema = z.object({
  enforcementEnabled: z.boolean(),
  defaultLimit: z.number().int().min(0).describe("Deployment default. 0 means no limit."),
  rules: z.array(workspaceLimitRuleSchema),
});
export type WorkspaceLimitSettings = z.infer<typeof workspaceLimitSettingsSchema>;

export const workspaceLimitRuleInputSchema = z.object({
  scope: workspaceLimitRuleScopeSchema,
  value: z.string().trim().min(3).max(320),
  limit: z.number().int().min(1).max(10_000).nullable(),
}).strict();
export type WorkspaceLimitRuleInput = z.infer<typeof workspaceLimitRuleInputSchema>;
