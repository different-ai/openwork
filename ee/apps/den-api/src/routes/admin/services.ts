import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { adminRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { checkDeploymentServices, deploymentServicesCheckResponses, deploymentServicesNoStore, deploymentServicesReadResponses, readDeploymentServices } from "../deployment-services.js"

export function registerAdminServiceReadinessRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/services", describeRoute({
    tags: ["Admin"], summary: "Read cached deployment service readiness", ...{ "x-mcp": false },
    description: "Fixed deployment diagnostics and the answering Den replica's version and start time. Never waits for an outbound check. A stale snapshot remains explicitly stale.",
    responses: deploymentServicesReadResponses,
  }), adminRoute(), deploymentServicesNoStore, readDeploymentServices)
  app.post("/v1/admin/services/check", describeRoute({
    tags: ["Admin"], summary: "Queue a deployment service readiness check", ...{ "x-mcp": false },
    description: "Queues bounded, read-only service checks: a database query, service health endpoints, and a mail sign-in or mail-provider domain lookup. Active checks and matching-configuration results completed within 30 seconds coalesce without changing timestamps or spending admission. Durable global admission limits new checks across replicas. Never sends email, calls a model, provisions credentials or initiates Slack events.",
    responses: deploymentServicesCheckResponses,
  }), adminRoute(), deploymentServicesNoStore, checkDeploymentServices)
}
