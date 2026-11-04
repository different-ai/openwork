import { and, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, PublicMcpAppTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { organizationFeatureEnabled } from "./features.js"
import { loadPinnedMcpAppRevision, McpAppError, publishableMcpAppRevision, type McpAppResource } from "./mcp-apps.js"
import type { PluginArchActorContext } from "./routes/org/plugin-system/access.js"

/** Where a public App is served. It needs no sign-in, unlike every /mcp/agent path. */
export const PUBLIC_MCP_APP_ROUTE = "/mcp/public/apps/:slug"

export function publicMcpAppPath(slug: string): string {
  return `/mcp/public/apps/${encodeURIComponent(slug)}`
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/

/** Whether `value` can name a public App: 3 to 48 lowercase letters, digits and hyphens. */
export function isPublicAppSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

/** A slug suggested from an App's title, e.g. "Coffee with the team" → "coffee-with-the-team". */
export function slugFromTitle(title: string): string {
  const base = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "")
  return base.length >= 3 ? base : `${base || "app"}-app`
}

type PublicMcpAppSummary = {
  publicationId: string
  slug: string
  appId: string
  revisionId: string
  title: string
  url: string
  publishedAt: string
}

type PublicationRow = typeof PublicMcpAppTable.$inferSelect

function summary(row: PublicationRow, title: string, origin: string): PublicMcpAppSummary {
  return {
    publicationId: row.id,
    slug: row.slug,
    appId: row.configObjectId,
    revisionId: row.configObjectVersionId,
    title,
    url: `${origin}${publicMcpAppPath(row.slug)}`,
    publishedAt: row.publishedAt.toISOString(),
  }
}

function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "ER_DUP_ENTRY") return true
  if ("errno" in error && error.errno === 1062) return true
  return "cause" in error && error.cause !== error && isDuplicateEntry(error.cause)
}

function slugTaken(slug: string): McpAppError {
  return new McpAppError(409, "public_app_slug_taken", `The public name "${slug}" is already used. Choose another name.`)
}

async function publicationForApp(organizationId: DenTypeId<"organization">, appId: DenTypeId<"configObject">) {
  const [row] = await db.select().from(PublicMcpAppTable).where(and(
    eq(PublicMcpAppTable.organizationId, organizationId),
    eq(PublicMcpAppTable.configObjectId, appId),
  )).limit(1)
  return row ?? null
}

/**
 * Publishes the App's current revision at its public URL, or pins a newer one
 * when it is already public. The slug defaults to the App's existing slug,
 * then to one made from its title; a slug used by any other App on the
 * deployment, published or not, is refused. The caller must be able to edit
 * the App. An App that declares tools is refused: a public App has nobody to
 * run them as.
 */
export async function publishMcpApp(input: { context: PluginArchActorContext; appId: string; slug?: string; origin: string }): Promise<PublicMcpAppSummary> {
  const organizationId = input.context.organizationContext.organization.id
  const memberId = input.context.organizationContext.currentMember.id
  const revision = await publishableMcpAppRevision({ context: input.context, appId: input.appId })
  if (revision.tools.length > 0) {
    throw new McpAppError(409, "public_app_has_tools", "Only Apps without tools can be published publicly. Remove the App's tools, or keep it shared through its Plugin.")
  }
  const appId = normalizeDenTypeId("configObject", revision.appId)
  const revisionId = normalizeDenTypeId("configObjectVersion", revision.revisionId)
  const existing = await publicationForApp(organizationId, appId)
  const slug = input.slug ?? existing?.slug ?? slugFromTitle(revision.title)
  if (!isPublicAppSlug(slug)) {
    throw new McpAppError(400, "public_app_slug_invalid", `"${slug}" can't be a public name. Use 3 to 48 lowercase letters, digits and hyphens.`)
  }
  const publishedAt = new Date()
  const changes = { slug, configObjectVersionId: revisionId, publishedByOrgMembershipId: memberId, publishedAt, unpublishedAt: null }
  try {
    if (existing) {
      await db.update(PublicMcpAppTable).set(changes).where(eq(PublicMcpAppTable.id, existing.id))
    } else {
      await db.insert(PublicMcpAppTable).values({ id: createDenTypeId("publicMcpApp"), organizationId, configObjectId: appId, ...changes })
    }
  } catch (error) {
    // Each App has one row and each slug one App. Neither duplicate is
    // resolved by overwriting, which could move another App's URL.
    if (isDuplicateEntry(error)) throw slugTaken(slug)
    throw error
  }
  const row = await publicationForApp(organizationId, appId)
  if (!row || row.slug !== slug) throw slugTaken(slug)
  return summary(row, revision.title, input.origin)
}

/** Stops serving the App publicly. Its URL is refused until it is published again. */
export async function unpublishMcpApp(input: { organizationId: DenTypeId<"organization">; appId: string }): Promise<boolean> {
  let appId: DenTypeId<"configObject">
  try {
    appId = normalizeDenTypeId("configObject", input.appId)
  } catch {
    return false
  }
  const row = await publicationForApp(input.organizationId, appId)
  if (!row || row.unpublishedAt) return false
  await db.update(PublicMcpAppTable).set({ unpublishedAt: new Date() }).where(eq(PublicMcpAppTable.id, row.id))
  return true
}

/** The organization's Apps that are public now, newest first. */
export async function listPublicMcpApps(input: { organizationId: DenTypeId<"organization">; origin: string }): Promise<PublicMcpAppSummary[]> {
  const rows = await db.select({ publication: PublicMcpAppTable, title: ConfigObjectTable.title })
    .from(PublicMcpAppTable)
    .innerJoin(ConfigObjectTable, and(
      eq(ConfigObjectTable.id, PublicMcpAppTable.configObjectId),
      eq(ConfigObjectTable.organizationId, PublicMcpAppTable.organizationId),
      isNull(ConfigObjectTable.deletedAt),
    ))
    .where(and(eq(PublicMcpAppTable.organizationId, input.organizationId), isNull(PublicMcpAppTable.unpublishedAt)))
    .orderBy(desc(PublicMcpAppTable.publishedAt))
  return rows.map((row) => summary(row.publication, row.title, input.origin))
}

export type PublicMcpAppRefusal = "not_found" | "unpublished" | "feature_off" | "app_unavailable"

type PublicMcpAppLoad =
  | { ok: true; slug: string; resource: McpAppResource }
  | { ok: false; reason: PublicMcpAppRefusal; organizationId?: string }

/**
 * Everything a public App's server serves, checked on every request: the
 * publication is active, the feature is on for its organization, and the App
 * and its pinned revision still exist. Any failure refuses.
 */
export async function loadPublicMcpApp(slug: string): Promise<PublicMcpAppLoad> {
  if (!isPublicAppSlug(slug)) return { ok: false, reason: "not_found" }
  const [row] = await db.select().from(PublicMcpAppTable).where(eq(PublicMcpAppTable.slug, slug)).limit(1)
  if (!row) return { ok: false, reason: "not_found" }
  const organizationId = row.organizationId
  if (row.unpublishedAt) return { ok: false, reason: "unpublished", organizationId }
  if (!env.appMcpServersEnabled || !(await organizationFeatureEnabled(organizationId, "publicApps"))) {
    return { ok: false, reason: "feature_off", organizationId }
  }
  try {
    const pinned = await loadPinnedMcpAppRevision({ organizationId, appId: row.configObjectId, revisionId: row.configObjectVersionId })
    // Published without tools; a revision is immutable, so this only guards a corrupt row.
    if (pinned.tools.length > 0) return { ok: false, reason: "app_unavailable", organizationId }
    return { ok: true, slug: row.slug, resource: pinned }
  } catch (error) {
    if (error instanceof McpAppError) return { ok: false, reason: "app_unavailable", organizationId }
    throw error
  }
}
