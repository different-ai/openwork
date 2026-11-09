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

/**
 * Claude Code sign-in as the Connect a provider sheet and Settings see it.
 * Absent (undefined) whenever the person cannot use it: the feature is off,
 * the organization only allows its own providers, or no workspace is open.
 */
export type ClaudeAgentSetupState = {
  integration: ClaudeAgentIntegration | null;
  /** A connect, check or disconnect is running. */
  busy: boolean;
  /** Connect was pressed and the engine has not answered about `claude` yet. */
  checking: boolean;
  /** The engine's check of `claude` passed for the current connection in this app session. */
  verified: boolean;
  error: string | null;
};

/** The engine's provider id. People see it as "Claude Code", a way to connect Anthropic. */
export const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
export const CLAUDE_AGENT_HOST_PROVIDER_ID = "anthropic";
export const CLAUDE_CODE_NAME = "Claude Code";
export const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/setup";
export const CLAUDE_CODE_SIGN_IN_COMMAND = "claude auth login";
// The engine allows 30 seconds for `claude` to start and 30 more to read each model's context size.
export const CLAUDE_CODE_CHECK_TIMEOUT_MS = 65_000;
export const CLAUDE_CODE_CHECK_TIMEOUT_MESSAGE = "Couldn't confirm that Claude Code is ready. Make sure it's installed and signed in, then check again.";

/** The engine writes its reasons for a terminal, with commands in backticks; people read them as plain sentences. */
export function plainClaudeMessage(message: string) {
  return message.replaceAll("`", "");
}

/** The active connection's sign-in problem as the engine last reported it. */
export function claudeAgentProblem(state: ClaudeAgentSetupState | undefined) {
  const status = state?.integration?.connections[0]?.status;
  return status?.status === "needs_auth" ? { ...status, message: plainClaudeMessage(status.message) } : null;
}

export function claudeAgentConnected(state: ClaudeAgentSetupState | undefined) {
  return Boolean(state?.integration?.connections.length);
}
