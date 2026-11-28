import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ComputerAccessTable, ComputerGrantTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { refusal } from "@openwork/computers"
import { COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY, COMPUTER_SHELL_RUNNER_CAPABILITY, computerWholeVmScopeSchema, type Computer, type ComputerGrant, type ComputerPolicy } from "@openwork/types/den/computers"
import { readOrganizationRemoteSessionSettings } from "@openwork/types/den/remote-sessions"
import { db } from "../db.js"
import { readOrganizationMetadataColumn } from "../organization-metadata.js"

export function incomingComputerWorkRefusal(target: Computer, capabilities: readonly string[] | null | undefined) {
  if (target.kind === "registered_vm") return null
  if (target.kind === "member_machine" && target.provider === "openwork_desktop" && capabilities?.includes(COMPUTER_SHELL_RUNNER_CAPABILITY)) return null
  return refusal("not_available_yet", target)
}

export async function loadComputerPolicy(
  organizationId: DenTypeId<"organization">,
  targetId: DenTypeId<"remoteDevice">,
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<ComputerPolicy> {
  const database = tx ?? db.$primary
  const access = database.select({ choice: ComputerAccessTable.ownerChoice }).from(ComputerAccessTable).where(and(
    eq(ComputerAccessTable.organizationId, organizationId), eq(ComputerAccessTable.deviceId, targetId),
  )).limit(1)
  const organization = tx
    ? tx.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1).for("share").then(([row]) => row)
    : readOrganizationMetadataColumn(organizationId)
  const metadata = await organization
  const [owner] = await (tx ? access.for("share") : access)
  const grants = await database.select().from(ComputerGrantTable).where(and(
    eq(ComputerGrantTable.organizationId, organizationId), eq(ComputerGrantTable.targetDeviceId, targetId),
  ))
  return {
    organization: { allowed: metadata != null && readOrganizationRemoteSessionSettings(metadata.metadata).access !== "off" },
    owner: { choice: owner?.choice ?? null },
    grants: grants.flatMap<ComputerGrant>(({ sourceKey, folders }) => {
      if (sourceKey === COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY) {
        const scope = computerWholeVmScopeSchema.safeParse({ surface: "whole_vm", folders })
        return scope.success ? [{ source: { kind: "owner" }, targetId, scope: scope.data }] : []
      }
      return [{
        source: sourceKey === "workbot" || sourceKey === "owner" ? { kind: sourceKey } : { kind: "computer", id: sourceKey },
        targetId,
        scope: { surface: "sandbox", folders },
      }]
    }),
  }
}
