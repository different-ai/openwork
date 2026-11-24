import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { managedDeploymentCapabilitiesSchema, managedDeploymentCapabilityStates } from "@openwork/managed-deployments/capability-state"
import { normalizeAwsTargetForView } from "@openwork/managed-deployments/schema"
import type { Hono } from "hono"
import { db } from "../../db.js"
import { requireFeature } from "../../features.js"
import { orgPermissionRoute, paramValidator } from "../../middleware/index.js"
import { deploymentParam, operation } from "./managed-deployments.js"
import type { OrgRouteVariables } from "./shared.js"

export function registerManagedDeploymentCapabilityRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/managed-deployments/:deploymentId/capabilities", operation("Read what a managed deployment can do", "Lists Workbot, the Slack assistant, Automations, the AI Gateway and cloud computers for one deployment, each as on, off, needs_infrastructure (turning it on first installs something in the customer's cloud, through an approved run) or unsupported (this cloud cannot have it yet), with a fixed reason code. Computed from the deployment's recorded target, not from a live check: use the deployment's health for whether a service answers. A reason of needs_rollout_flag means a computer provider is chosen, and members see computers only once the remote computers feature is on in the installed OpenWork.", managedDeploymentCapabilitiesSchema, { mcp: false }),
    orgPermissionRoute("deployments.view"), requireFeature("managedDeployments"), paramValidator(deploymentParam), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const id = c.req.valid("param").deploymentId
      const [row] = await db.select().from(ManagedDeploymentTable).where(and(eq(ManagedDeploymentTable.id, id), eq(ManagedDeploymentTable.org_id, org.organization.id))).limit(1)
      if (!row || (row.provider !== "aws" && row.provider !== "gcp")) return c.json({ error: "deployment_not_found" }, 404)
      const states = managedDeploymentCapabilityStates(row.provider === "aws" ? { provider: "aws", target: normalizeAwsTargetForView(row.target) } : { provider: "gcp" })
      return c.json(managedDeploymentCapabilitiesSchema.parse({ deploymentId: row.id, ...states }))
    })
}
