import { z } from "zod";

export const claudeAgentIntegrationSchema = z.object({
  data: z.object({
    id: z.literal("claude-agent"),
    name: z.string(),
    methods: z.array(z.object({ id: z.string(), type: z.string(), label: z.string() })),
    connections: z.array(z.object({
      type: z.literal("credential"),
      id: z.string(),
      label: z.string(),
      method: z.literal("external"),
      status: z.object({ status: z.literal("needs_auth"), message: z.string(), url: z.string().optional() }).optional(),
    })),
  }),
});

export const claudeAgentIntegrationListSchema = z.object({ data: z.array(z.unknown()) });
export function parseClaudeAgentIntegrationList(value: unknown) {
  const list = claudeAgentIntegrationListSchema.safeParse(value);
  const item = list.success ? list.data.data.find((entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === "claude-agent") : undefined;
  const parsed = claudeAgentIntegrationSchema.safeParse({ data: item });
  if (!parsed.success) throw new Error("This server did not return supported Claude Code setup. Update OpenWork and check again.");
  return parsed.data.data;
}

export type ClaudeAgentIntegration = z.infer<typeof claudeAgentIntegrationSchema>["data"];
export type ClaudeAgentSetupState = {
  enabled: boolean;
  blockedReason: string | null;
  integration: ClaudeAgentIntegration | null;
  busy: boolean;
  error: string | null;
  catalogError: string | null;
};

export const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
export const CLAUDE_AGENT_ROLLOUT_REASON = "Claude Agent is not enabled for this organization or installation. Your OpenWork administrator can enable it.";
export function claudeAgentStatus(state: ClaudeAgentSetupState): string {
  if (state.blockedReason) return state.blockedReason;
  if (state.error) return "Could not check connection. Check again.";
  const active = state.integration?.connections[0];
  if (active?.status?.status === "needs_auth") return active.status.message;
  return state.integration?.connections.length ? "Connection saved" : "Use Claude Code on the workspace computer";
}
