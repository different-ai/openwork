/**
 * The execution plan as stored (encrypted) on a change request next to its
 * plan. Apply runs it instead of re-planning against every area: it re-reads
 * only the items it writes (see `./apply-check.ts`). Parsed strictly on read;
 * anything that doesn't parse makes the caller fall back to a full re-plan.
 */
import {
  CONFIG_MATCH_TIERS,
  CONFIG_PLAN_OPS,
  configAreaKeySchema,
} from "@openwork/types/den/config-blobs"
import { z } from "zod"
import type { ExecutionPlan } from "./plan.js"

const specSchema = z.record(z.string(), z.unknown())

const configItemSchema = z.object({
  id: z.string(),
  key: z.string().nullable().optional(),
  name: z.string(),
  spec: specSchema,
})

const resolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("target"), id: z.string(), via: z.enum(["target", "decision"]) }),
  z.object({ kind: z.literal("planned"), area: configAreaKeySchema, ref: z.string() }),
  z.object({ kind: z.literal("drop") }),
  z.object({ kind: z.literal("invite"), email: z.string() }),
  z.object({ kind: z.literal("unresolved"), reason: z.string() }),
])

const fieldChangeSchema = z.object({
  path: z.string(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  base: z.unknown().optional(),
  conflict: z.boolean().optional(),
  added: z.array(z.unknown()).optional(),
  removed: z.array(z.unknown()).optional(),
})

const executionOpSchema = z.object({
  area: configAreaKeySchema,
  ref: z.string(),
  kind: z.enum(["create", "update", "delete"]),
  op: z.enum(CONFIG_PLAN_OPS),
  matchedBy: z.enum(CONFIG_MATCH_TIERS).nullable(),
  targetId: z.string().optional(),
  preferredId: z.string().optional(),
  item: z.object({
    sourceId: z.string().optional(),
    key: z.string().nullable().optional(),
    name: z.string(),
    spec: specSchema,
  }).optional(),
  refs: z.array(z.object({ path: z.string(), ref: z.string(), name: z.string().optional(), resolution: resolutionSchema })),
  secrets: z.array(z.object({ path: z.string(), field: z.string(), decision: z.enum(["keep", "env", "value", "unset"]), env: z.string().optional() })),
  previous: configItemSchema.optional(),
  name: z.string(),
  changes: z.array(fieldChangeSchema),
  secretPaths: z.array(z.string()),
  targetRev: z.string().optional(),
  irreversible: z.array(z.string()),
})

const executionPlanSchema = z.object({
  planHash: z.string(),
  blocking: z.number().int(),
  ops: z.array(executionOpSchema),
})

/** The stored execution plan, or null when it is missing, malformed or for another plan hash. */
export function parseStoredExecution(value: unknown, planHash: string | null): ExecutionPlan | null {
  if (value === null || value === undefined || !planHash) return null
  const parsed = executionPlanSchema.safeParse(value)
  if (!parsed.success || parsed.data.planHash !== planHash) return null
  const plan: ExecutionPlan = parsed.data
  return plan
}
