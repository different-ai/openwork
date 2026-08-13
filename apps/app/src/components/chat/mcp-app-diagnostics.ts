export type McpAppDiagnosticStage =
  | "resource-resolution"
  | "sandbox-proxy"
  | "resource-delivery"
  | "app-initialization"
  | "tool-result-delivery"

export type McpAppDiagnostic = {
  code: string
  causeCode?: string
  stage: McpAppDiagnosticStage
  message: string
  toolName: string
  resourceUri?: string
  sandboxOrigin?: string
  elapsedMs: number
  checkpoints: string[]
  sandboxDocument?: {
    readyState: string | null
    hasHtmlRoot: boolean | null
    scriptCount: number | null
  }
}

export function safeMcpAppDiagnosticMessage(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback
  return raw
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/([?&](?:token|access_token|authorization)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500)
}

export function formatMcpAppDiagnostic(diagnostic: McpAppDiagnostic): string {
  const document = diagnostic.sandboxDocument
  return [
    `Code: ${diagnostic.code}`,
    diagnostic.causeCode ? `Cause code: ${diagnostic.causeCode}` : null,
    `Stage: ${diagnostic.stage}`,
    `Message: ${diagnostic.message}`,
    `Tool: ${diagnostic.toolName}`,
    diagnostic.resourceUri ? `Resource: ${diagnostic.resourceUri}` : null,
    diagnostic.sandboxOrigin ? `Sandbox origin: ${diagnostic.sandboxOrigin}` : null,
    `Elapsed: ${diagnostic.elapsedMs} ms`,
    document ? `Document: readyState=${document.readyState ?? "unknown"}, htmlRoot=${document.hasHtmlRoot ?? "unknown"}, scripts=${document.scriptCount ?? "unknown"}` : null,
    `Checkpoints: ${diagnostic.checkpoints.length ? diagnostic.checkpoints.join(" -> ") : "none"}`,
  ].filter((line): line is string => line !== null).join("\n")
}
