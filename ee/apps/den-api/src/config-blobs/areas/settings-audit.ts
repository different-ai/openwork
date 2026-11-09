/**
 * Config-blob area `settings.audit` (Observability › Audit logs › Settings):
 * one item, whether the organization captures audit logs.
 *
 * - Carried: `captureOn`, the one setting an organization administrator
 *   changes (PATCH /v1/audit/settings).
 * - Never carried: the rest of `audit_policy` (categories, allowance, excess
 *   mode, attachment window, source): the platform operator or the plan sets
 *   them, and the target keeps its own. `audit_state` and every audit event
 *   and operation are runtime.
 * - Export never provisions anything: an entitled organization without a
 *   policy yet exports what it would get on first read (capture on).
 *
 * Apply goes through the route's own function (`setOrganizationAuditCapture`):
 * membership and Manage audit settings re-checked in the transaction, the
 * entitlement and deployment checks for turning capture on, and the
 * revision check against the policy read just before.
 */
import { readAuditPolicy } from "@openwork-ee/den-db/audit-log"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { readAuditAvailability } from "../../audit/capture.js"
import { env } from "../../env.js"
import { setOrganizationAuditCapture } from "../../routes/org/audit.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ApplySteps, ConfigFieldError, ORG_SINGLETON_NATURAL_KEY, readSingleton, touches } from "./org-singleton.js"
import { specObject } from "./route-support.js"

const AREA = "settings.audit"
const ITEM_NAME = "Audit log settings"

const auditSpecSchema = z.object({
  /** Whether audit events are captured (needs the audit entitlement and capture on this deployment to turn on). */
  captureOn: z.boolean().default(false),
}).strict()

async function readState(ctx: ConfigAreaContext) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const { entitlement } = await readAuditAvailability(ctx.db, organizationId)
  const policy = await readAuditPolicy(ctx.db, organizationId)
  // Without a policy, the first read of an entitled organization creates one with capture on (initializeAuditPolicyInTx).
  const captureOn = policy ? policy.enabled : entitlement.enabled && env.auditCaptureEnabled
  return { captureOn, revision: policy?.revision ?? 0, entitled: entitlement.enabled }
}

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  const { captureOn } = await readState(ctx)
  return [{ id: ctx.organizationId, name: ITEM_NAME, spec: { captureOn } }]
}

export const settingsAuditArea = defineConfigArea({
  key: AREA,
  label: "Audit logs",
  path: ["Observability", "Audit logs", "Settings"],
  specVersion: 1,
  specSchema: auditSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "audit.view",
  managePermission: "audit.manage",
  tables: ["audit_policy"],
  naturalKeys: [ORG_SINGLETON_NATURAL_KEY],
  secretFields: [],
  // setOrganizationAuditCapture opens its own transaction on the global db (and records the change in the audit log).
  transactional: false,
  protectedFromDelete: () => "Audit log settings can't be deleted.",

  irreversible(op) {
    if (op.kind === "delete") return []
    if (specObject(op.item.spec).captureOn === false && (op.kind === "create" || op.previous.spec.captureOn !== false)) {
      return ["Audit capture turns off: nothing that happens until it is turned back on is ever recorded."]
    }
    return []
  },

  exportItems,
  readItems: (ctx, ids) => readSingleton(ctx, ids, exportItems),

  async apply(ctx, op) {
    const steps = new ApplySteps()
    if (op.kind === "delete") throw steps.fail("not_deletable", "Audit log settings can't be deleted.")
    const localId = ctx.organizationId
    const parsed = auditSpecSchema.safeParse(specObject(op.item.spec))
    if (!parsed.success) throw steps.fail("invalid_spec", parsed.error.issues[0]?.message ?? "Invalid audit settings.", "captureOn")
    if (!touches(op, "captureOn")) return { localId, steps: [] }
    const current = await readState(ctx)
    const captureOn = parsed.data.captureOn
    if (current.captureOn === captureOn) return { localId, steps: [] }
    if (!env.auditVisibilityEnabled) throw steps.fail("audit_visibility_disabled", "Audit logs aren't available on this deployment.", "captureOn", 403)

    await steps.run({ action: "set", target: "captureOn", detail: captureOn ? "on" : "off" }, "captureOn", async () => {
      const rejection = await setOrganizationAuditCapture({
        organizationId: normalizeDenTypeId("organization", ctx.organizationId),
        member: { id: normalizeDenTypeId("member", ctx.actor.memberId), userId: normalizeDenTypeId("user", ctx.actor.userId) },
        credentialId: undefined,
        requestId: createDenTypeId("request"),
        input: { captureOn, expectedRevision: current.revision },
      })
      if (rejection === "forbidden") throw new ConfigFieldError("forbidden", "You need the Manage audit settings permission to change audit capture.", "captureOn", 403)
      if (rejection === "enterprise_plan_required") throw new ConfigFieldError(rejection, "Audit logs requires an Enterprise plan or explicit self-hosted installation entitlement.", "captureOn", 402)
      if (rejection === "audit_capture_unavailable") throw new ConfigFieldError(rejection, "Audit capture isn't available on this deployment yet.", "captureOn", 409)
    })
    return { localId, steps: steps.done }
  },
})
