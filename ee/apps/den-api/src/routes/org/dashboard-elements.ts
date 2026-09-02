import type { DashboardElement } from "@openwork-ee/den-db/schema"
import { z } from "zod"

export const dashboardElementSchema = z.object({
  serverName: z.string().trim().min(1).max(255),
  connectionId: z.string().trim().min(1).max(160).optional(),
  toolName: z.string().trim().min(1).max(256),
  projectedToolName: z.string().trim().min(1).max(256),
  resourceUri: z.string().trim().min(1).max(2048).refine((value) => value.startsWith("ui://"), {
    message: "MCP App resource URIs must use ui://.",
  }),
  title: z.string().trim().min(1).max(255),
  launchArguments: z.record(z.string(), z.unknown()).optional(),
  requiresApproval: z.boolean().optional(),
  organizationAutoLaunch: z.boolean().optional(),
}).meta({ ref: "DashboardElement" })

export type DashboardElementInput = z.infer<typeof dashboardElementSchema>

export function toStoredDashboardElement(value: DashboardElementInput): DashboardElement {
  return {
    serverName: value.serverName,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}),
    toolName: value.toolName,
    projectedToolName: value.projectedToolName,
    resourceUri: value.resourceUri,
    title: value.title,
    ...(value.launchArguments ? { launchArguments: value.launchArguments } : {}),
    ...(value.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(value.organizationAutoLaunch === true ? { organizationAutoLaunch: true } : {}),
  }
}

export function parseStoredDashboardElements(value: unknown): DashboardElement[] {
  let decoded = value
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value)
    } catch {
      return []
    }
  }

  const parsed = z.array(dashboardElementSchema).safeParse(decoded)
  return parsed.success ? parsed.data.map(toStoredDashboardElement) : []
}
