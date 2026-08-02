import { and, eq } from "@openwork-ee/den-db/drizzle"
import { CliConnectorTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

export type CliConnectorRow = typeof CliConnectorTable.$inferSelect

export async function listCliConnectors(
  organizationId: DenTypeId<"organization">,
): Promise<CliConnectorRow[]> {
  return db
    .select()
    .from(CliConnectorTable)
    .where(eq(CliConnectorTable.organizationId, organizationId))
    .orderBy(CliConnectorTable.name)
}

export async function listEnabledCliConnectors(
  organizationId: DenTypeId<"organization">,
): Promise<CliConnectorRow[]> {
  return db
    .select()
    .from(CliConnectorTable)
    .where(and(
      eq(CliConnectorTable.organizationId, organizationId),
      eq(CliConnectorTable.enabled, true),
    ))
    .orderBy(CliConnectorTable.name)
}

export async function getCliConnector(input: {
  organizationId: DenTypeId<"organization">
  connectionId: DenTypeId<"cliConnector">
}): Promise<CliConnectorRow | null> {
  const rows = await db
    .select()
    .from(CliConnectorTable)
    .where(and(
      eq(CliConnectorTable.organizationId, input.organizationId),
      eq(CliConnectorTable.id, input.connectionId),
    ))
    .limit(1)
  return rows[0] ?? null
}

export async function enableCliConnector(input: {
  organizationId: DenTypeId<"organization">
  catalogKey: string
  name: string
  manifestVersion: string
  createdByOrgMembershipId: DenTypeId<"member">
}): Promise<CliConnectorRow> {
  await db
    .insert(CliConnectorTable)
    .values({
      id: createDenTypeId("cliConnector"),
      organizationId: input.organizationId,
      catalogKey: input.catalogKey,
      name: input.name,
      manifestVersion: input.manifestVersion,
      enabled: true,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
    .onDuplicateKeyUpdate({
      set: {
        name: input.name,
        manifestVersion: input.manifestVersion,
        enabled: true,
        updatedAt: new Date(),
      },
    })

  const rows = await db
    .select()
    .from(CliConnectorTable)
    .where(and(
      eq(CliConnectorTable.organizationId, input.organizationId),
      eq(CliConnectorTable.catalogKey, input.catalogKey),
    ))
    .limit(1)
  const connection = rows[0]
  if (!connection) throw new Error("CLI connector upsert did not return a row")
  return connection
}
