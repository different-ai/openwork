import type { FeatureMap } from "@openwork/features"

/**
 * What members of an organization see on the agent rail and in the desktop
 * library, derived from its features. The one place that knows how the three
 * are derived until organization modules replace it.
 *
 * - connect: the organization's connections (MCP, native providers, App
 *   building). Only `mcpConnections` turns it off.
 * - marketplace: marketplace skills and plugin capabilities (list_skills,
 *   get_skill, skill:// resources, plugin: capabilities, the desktop's assigned
 *   capabilities).
 * - workflows: Workflows through the marketplace source. Needs marketplace.
 *
 * Turning Connect off used to hide marketplace and Workflows too. Until
 * `libraryWithoutConnect` is rolled out, an organization with Connect off keeps
 * that behavior; with it on, Connect off hides only connections.
 */
export type MemberFacingSurfaces = {
  connect: boolean
  marketplace: boolean
  workflows: boolean
}

export type MemberFacingSurfaceFeatures = Pick<FeatureMap, "mcpConnections" | "libraryWithoutConnect">

export function memberFacingSurfaces(features: MemberFacingSurfaceFeatures): MemberFacingSurfaces {
  const connect = features.mcpConnections
  const marketplace = connect || features.libraryWithoutConnect
  return { connect, marketplace, workflows: marketplace }
}
