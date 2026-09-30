import { readFile, open } from "node:fs/promises"
import { parseArgs } from "node:util"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createDenDb } from "../src/client"
import {
  listPendingGatewayUsageRequests,
  recoverGatewayUsageRequests,
  rotateGatewayUsageEpoch,
} from "../src/gateway-usage-operations"
import { safeUsageDatabaseCode } from "../src/gateway-usage-errors"
import { localConnectionConfig } from "./dev-migrate"

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid manifest")
  return value
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      output: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  })
  if (!values.manifest || !values.output)
    throw new Error("Explicit manifest and private output paths are required")
  const input: unknown = JSON.parse(await readFile(values.manifest, "utf8"))
  if (!object(input) || !object(input.actor)) throw new Error("Invalid manifest")
  const actor = {
    organizationId: normalizeDenTypeId("organization", text(input.actor.organizationId)),
    memberId: normalizeDenTypeId("member", text(input.actor.memberId)),
  }
  const databaseUrl = process.env.DEN_USAGE_OPERATIONS_DATABASE_URL ?? ""
  localConnectionConfig(databaseUrl)
  const output = await open(values.output, "wx", 0o600)
  const { db, client } = createDenDb({ databaseUrl, mode: "mysql" })
  try {
    let result: unknown
    switch (input.operation) {
      case "pending":
        if (values.apply) throw new Error("Pending inspection is read-only")
        result = await listPendingGatewayUsageRequests(db, {
          actor,
          memberId: normalizeDenTypeId("member", text(input.memberId)),
          before: text(input.before),
        })
        break
      case "recover":
        if (!Array.isArray(input.requestIds)) throw new Error("Invalid manifest")
        result = await recoverGatewayUsageRequests(db, {
          actor,
          requestIds: input.requestIds.map(text),
          abandonedBefore: text(input.abandonedBefore),
          reviewReference: text(input.reviewReference),
          apply: values.apply,
        })
        break
      case "suspend":
      case "resume": {
        if (!Array.isArray(input.members)) throw new Error("Invalid manifest")
        const members = input.members.map((member: unknown) => {
          if (!object(member) || typeof member.expectedVersion !== "number")
            throw new Error("Invalid manifest")
          return {
            memberId: normalizeDenTypeId("member", text(member.memberId)),
            expectedVersion: member.expectedVersion,
          }
        })
        result = await rotateGatewayUsageEpoch(db, {
          actor,
          members,
          action: input.operation,
          reviewReference: text(input.reviewReference),
          apply: values.apply,
        })
        break
      }
      default:
        throw new Error("Unsupported operation")
    }
    await output.writeFile(JSON.stringify(result, null, 2))
    console.log(
      JSON.stringify({ stage: "usage_operation", applied: values.apply, status: "complete" }),
    )
  } finally {
    await output.close()
    if ("end" in client) await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      stage: "usage_operation",
      status: "failed",
      code: safeUsageDatabaseCode(error),
    }),
  )
  process.exitCode = 1
})
