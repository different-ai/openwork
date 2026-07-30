import { eq } from "@openwork-ee/den-db/drizzle"
import { UiArtifactPreferenceTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  UI_ARTIFACT_KINDS,
  UI_ARTIFACT_SCHEMA_VERSION,
  uiArtifactPreferencesUpdateSchema,
  type UiArtifactPreferences,
  type UiArtifactPreferencesUpdate,
} from "@openwork/types/ui-artifact"
import { db } from "./db.js"

const DEFAULT_UI_ARTIFACT_PREFERENCES: UiArtifactPreferences = {
  protocol: "openwork.ui-artifact-preferences",
  schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
  enabled: false,
  enabledArtifactIds: [...UI_ARTIFACT_KINDS],
  updatedAt: null,
}

function normalizedUpdate(value: unknown): UiArtifactPreferencesUpdate {
  const parsed = uiArtifactPreferencesUpdateSchema.parse(value)
  return {
    enabled: parsed.enabled,
    enabledArtifactIds: UI_ARTIFACT_KINDS.filter((artifactId) => (
      parsed.enabledArtifactIds.includes(artifactId)
    )),
  }
}

function normalizedStoredArtifactIds(value: unknown): UiArtifactPreferences["enabledArtifactIds"] {
  const stored = Array.isArray(value) ? value : []
  return UI_ARTIFACT_KINDS.filter((artifactId) => (
    stored.includes(artifactId)
    || (artifactId === "calendar.view" && stored.includes("calendar.day"))
    || (
      artifactId === "widgets.collection"
      && (stored.includes("metrics.glance") || stored.includes("work.progress"))
    )
  ))
}

export async function readUiArtifactPreferences(memberId: string): Promise<UiArtifactPreferences> {
  const normalizedMemberId = normalizeDenTypeId("member", memberId)
  const rows = await db
    .select({
      enabled: UiArtifactPreferenceTable.enabled,
      enabledArtifactIds: UiArtifactPreferenceTable.enabledArtifactIds,
      updatedAt: UiArtifactPreferenceTable.updatedAt,
    })
    .from(UiArtifactPreferenceTable)
    .where(eq(UiArtifactPreferenceTable.memberId, normalizedMemberId))
    .limit(1)
  const row = rows[0]
  if (!row) return DEFAULT_UI_ARTIFACT_PREFERENCES

  const enabledArtifactIds = normalizedStoredArtifactIds(row.enabledArtifactIds)
  return {
    protocol: "openwork.ui-artifact-preferences",
    schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
    enabled: row.enabled === true,
    enabledArtifactIds,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function writeUiArtifactPreferences(
  memberId: string,
  value: unknown,
): Promise<UiArtifactPreferences> {
  const normalizedMemberId = normalizeDenTypeId("member", memberId)
  const update = normalizedUpdate(value)
  const updatedAt = new Date()
  await db
    .insert(UiArtifactPreferenceTable)
    .values({
      memberId: normalizedMemberId,
      enabled: update.enabled,
      enabledArtifactIds: update.enabledArtifactIds,
      updatedAt,
    })
    .onDuplicateKeyUpdate({
      set: {
        enabled: update.enabled,
        enabledArtifactIds: update.enabledArtifactIds,
        updatedAt,
      },
    })

  return {
    protocol: "openwork.ui-artifact-preferences",
    schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
    ...update,
    updatedAt: updatedAt.toISOString(),
  }
}
