import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { orgMemberRoute } from "../../middleware/index.js"
import type { OrgRouteVariables } from "./shared.js"

/**
 * Compatibility stubs for the retired Workflow-bound saved apps (generated
 * Artifact views, D36). Published desktops still call these routes, so they
 * keep answering exactly as they did with DEN_GENERATED_ARTIFACT_VIEWS_ENABLED
 * off: the list says saved apps are disabled, everything else is absent.
 * Hidden from OpenAPI and MCP. Remove once supported desktops no longer call
 * them (D19 window, W0-P13 open question 2).
 */
const legacySavedAppRoute = { hide: true, "x-mcp": false } as const

const LEGACY_SAVED_APP_PATHS = [
  ["get", "/v1/apps/:appId"],
  ["post", "/v1/apps/:appId/share"],
  ["post", "/v1/apps/:appId/dashboard"],
  ["post", "/v1/apps/:appId/save"],
  ["post", "/v1/artifact-views/:artifactViewId/retire"],
] as const

export function registerOrgLegacySavedAppRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/apps",
    describeRoute(legacySavedAppRoute),
    orgMemberRoute(),
    (c) => c.json({ enabled: false, sharingEnabled: false, items: [] }),
  )

  for (const [method, path] of LEGACY_SAVED_APP_PATHS) {
    app[method](
      path,
      describeRoute(legacySavedAppRoute),
      orgMemberRoute(),
      (c) => c.json({ error: "artifact_view_not_found" }, 404),
    )
  }
}
