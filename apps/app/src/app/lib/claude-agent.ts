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

const claudeCodeInstalled = { installed: z.boolean().optional() };
export const claudeCodeSignInSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle"), ...claudeCodeInstalled }),
  z.object({ status: z.literal("waiting"), ...claudeCodeInstalled }),
  z.object({ status: z.literal("signed_in"), ...claudeCodeInstalled }),
  z.object({ status: z.literal("failed"), message: z.string(), ...claudeCodeInstalled }),
]);
export type ClaudeCodeSignIn = z.infer<typeof claudeCodeSignInSchema>;

export type ClaudeAgentSetupState = {
  integration: ClaudeAgentIntegration | null;
  busy: boolean;
  checking: boolean;
  verified: boolean;
  error: string | null;
  canSignIn?: boolean;
  signingIn?: boolean;
  installed?: boolean;
};

export const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
export const CLAUDE_AGENT_HOST_PROVIDER_ID = "anthropic";
export const CLAUDE_CODE_NAME = "Claude Code";
export const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/setup";
export const CLAUDE_CODE_SIGN_IN_COMMAND = "claude auth login";
export const CLAUDE_CODE_CHECK_TIMEOUT_MS = 65_000;
export const CLAUDE_CODE_SIGN_IN_POLL_MS = 1_000;
export const CLAUDE_CODE_INSTALL_POLL_MS = 3_000;
export const CLAUDE_CODE_CHECK_TIMEOUT_MESSAGE = "Couldn't confirm that Claude Code is ready. Make sure it's installed and signed in, then check again.";

export function plainClaudeMessage(message: string) {
  return message.replaceAll("`", "");
}

export function claudeCodeMissing(message: string | null | undefined) {
  return /\bnot installed\b/i.test(message ?? "");
}

export function claudeAgentProblem(state: ClaudeAgentSetupState | undefined) {
  const status = state?.integration?.connections[0]?.status;
  return status?.status === "needs_auth" ? { ...status, message: plainClaudeMessage(status.message) } : null;
}

export function claudeAgentConnected(state: ClaudeAgentSetupState | undefined) {
  return Boolean(state?.integration?.connections.length);
}
