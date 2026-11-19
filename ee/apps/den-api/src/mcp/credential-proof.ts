/** The verified MCP credential behind an internal request; never client-supplied tool input. */
export type McpCredentialProofSource =
  | { kind: "session"; sessionId: string }
  | { kind: "grant"; grantId: string }
  | { kind: "run"; tokenId: string }

export function isMcpCredentialProofSource(value: unknown): value is McpCredentialProofSource {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false
  if (value.kind === "session") return "sessionId" in value && typeof value.sessionId === "string"
  if (value.kind === "grant") return "grantId" in value && typeof value.grantId === "string"
  if (value.kind === "run") return "tokenId" in value && typeof value.tokenId === "string"
  return false
}
