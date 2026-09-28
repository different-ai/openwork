// Header names must match ee/apps/den-api/src/bot-protection-policy.ts.
export type LoginAgentContext =
  | { kind: "mcp-oauth"; oauthQuery: string }
  | { kind: "device"; userCode: string }
  | { kind: "claim"; userCode: string };

/**
 * Headers that let Den API skip BotID for an agent-initiated sign-in. Den API
 * verifies each value (signature or live code); an invalid value falls back
 * to normal bot protection.
 */
export function loginAgentContextHeaders(context: LoginAgentContext | undefined): Record<string, string> | null {
  if (!context) return null;
  if (context.kind === "mcp-oauth") {
    const value = context.oauthQuery.replace(/^\?/, "").trim();
    return value ? { "x-openwork-oauth-query": value } : null;
  }
  const code = context.userCode.replace(/-/g, "").trim();
  if (!code) return null;
  return context.kind === "device"
    ? { "x-openwork-device-user-code": code }
    : { "x-openwork-claim-user-code": code };
}
