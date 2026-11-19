import { useState } from "react"
import { mcpAppToolNameSchema } from "@openwork/types/mcp-app"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Den's reason on a refusal only an editor updating the App can fix, with the App tool it names. */
const MCP_APP_NEEDS_UPDATE = "app_needs_update"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The App tool a failed call says changed at its provider, or null. Only the
 * tool the App just called counts, so a provider's own error text cannot name
 * another one.
 */
export function changedMcpAppTool(result: unknown, calledTool: string): string | null {
  if (!isRecord(result) || result.isError !== true || !Array.isArray(result.content)) return null
  if (!mcpAppToolNameSchema.safeParse(calledTool).success) return null
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue
    try {
      const payload: unknown = JSON.parse(item.text)
      if (isRecord(payload) && payload.reason === MCP_APP_NEEDS_UPDATE && payload.tool === calledTool) return calledTool
    } catch {
      // Not OpenWork's JSON error.
    }
  }
  return null
}

/** The request a new conversation starts with, to update an App whose tool changed. */
export function mcpAppToolRepairPrompt({ appId, title, tool }: { appId: string; title: string; tool: string }): string {
  return `Fix the existing artifact “${title}” (artifact ID: ${appId}). Its tool “${tool}” changed at its provider since the artifact was published, so OpenWork blocks its calls to it. Follow the build-an-app skill: read the artifact with read_app using this artifact ID, find what the tool takes and returns now, then save the fix with update_app under this same artifact ID, changing its code where the tool changed. Do not create a copy. Tell me what you changed.`
}

/** Shown above an App whose tool changed, to someone who can update the App. */
export function McpAppChangedToolPrompt({ tool, onFix, className }: {
  tool: string
  onFix: (tool: string) => Promise<void>
  className?: string
}) {
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle")
  const fix = async () => {
    setState("opening")
    try {
      await onFix(tool)
      setState("idle")
    } catch {
      setState("failed")
    }
  }
  return (
    <div data-testid="mcp-app-changed-tool" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-background px-3 py-2", className)}>
      <p className="min-w-0 flex-1 text-sm">“{tool}” changed since this artifact was published. Update the artifact to use the tool again.</p>
      <Button variant="outline" size="sm" disabled={state === "opening"} onClick={() => void fix()}>
        {state === "opening" ? "Opening conversation…" : "Fix with agent"}
      </Button>
      {state === "failed" ? <p role="alert" className="w-full text-xs text-destructive">Could not start a conversation. Try again.</p> : null}
    </div>
  )
}
