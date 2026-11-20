import { and, asc, desc, eq, isNotNull, isNull, ne, notExists, or, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable as ObjectGrant,
  ConfigObjectTable as ObjectRow,
  ConfigObjectVersionTable as Version,
  ConnectorSourceBindingTable as SourceBinding,
  MarketplacePluginTable as Listing,
  PluginAccessGrantTable as PluginGrant,
  PluginConfigObjectTable as Component,
  PluginTable as Plugin,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  PERSONAL_SKILLS_FORMAT,
  PERSONAL_SKILLS_MAX_BYTES,
  PERSONAL_SKILLS_MAX_COUNT,
  PERSONAL_SKILLS_VERSION,
  PERSONAL_SKILL_SOURCE_MAX_BYTES,
  type PersonalSkillsBundle,
} from "@openwork/types/den/personal-skills"
import { db } from "../../../db.js"
import { requirePluginArchCapability, type PluginArchActorContext } from "./access.js"
import { createPluginBundle, deriveSkillProjection, PluginArchRouteFailure } from "./store.js"

const exists = (query: { getSQL(): SQL }) => sql`exists ${query}`

export async function exportPersonalSkills(context: PluginArchActorContext): Promise<PersonalSkillsBundle> {
  const { organization: { id: orgId }, currentMember: { id: memberId } } = context.organizationContext

  // Compose the privacy check and payload read into one statement, so a share,
  // attachment or version change cannot fall between the two.
  const latestVersion = db.select({ id: Version.id }).from(Version).where(and(
    eq(Version.configObjectId, ObjectRow.id), eq(Version.organizationId, orgId),
  )).orderBy(desc(Version.createdAt), desc(Version.id)).limit(1)
  const ownGrant = db.select({ id: ObjectGrant.id }).from(ObjectGrant).where(and(
    eq(ObjectGrant.configObjectId, ObjectRow.id), eq(ObjectGrant.organizationId, orgId),
    isNull(ObjectGrant.removedAt), eq(ObjectGrant.orgMembershipId, memberId),
  ))
  const sharedGrant = db.select({ id: ObjectGrant.id }).from(ObjectGrant).where(and(
    eq(ObjectGrant.configObjectId, ObjectRow.id), eq(ObjectGrant.organizationId, orgId),
    isNull(ObjectGrant.removedAt),
    or(eq(ObjectGrant.orgWide, true), isNotNull(ObjectGrant.teamId), ne(ObjectGrant.orgMembershipId, memberId)),
  ))
  const sharedPluginGrant = db.select({ id: PluginGrant.id }).from(PluginGrant).where(and(
    eq(PluginGrant.pluginId, Plugin.id), eq(PluginGrant.organizationId, orgId),
    isNull(PluginGrant.removedAt),
    or(eq(PluginGrant.orgWide, true), isNotNull(PluginGrant.teamId), ne(PluginGrant.orgMembershipId, memberId)),
  ))
  const listing = db.select({ id: Listing.id }).from(Listing).where(and(
    eq(Listing.pluginId, Plugin.id), eq(Listing.organizationId, orgId), isNull(Listing.removedAt),
  ))
  const nonPersonalPluginComponent = db.select({ id: Component.id }).from(Component)
    .innerJoin(Plugin, and(eq(Plugin.id, Component.pluginId), eq(Plugin.organizationId, orgId)))
    .where(and(
      eq(Component.configObjectId, ObjectRow.id), eq(Component.organizationId, orgId), isNull(Component.removedAt),
      or(ne(Plugin.createdByOrgMembershipId, memberId), isNotNull(Plugin.sourceRepositoryUrl),
        isNotNull(Plugin.sourceFormat), isNotNull(Component.connectorMappingId), exists(sharedPluginGrant), exists(listing)),
    ))
  const connectedSource = db.select({ id: SourceBinding.id }).from(SourceBinding).where(and(
    eq(SourceBinding.configObjectId, ObjectRow.id), eq(SourceBinding.organizationId, orgId),
  ))

  const rows = await db.select({ source: Version.rawSourceText }).from(ObjectRow)
    .innerJoin(Version, eq(Version.id, latestVersion))
    .where(and(
      eq(ObjectRow.organizationId, orgId), eq(ObjectRow.createdByOrgMembershipId, memberId),
      eq(ObjectRow.objectType, "skill"), eq(ObjectRow.sourceMode, "cloud"), eq(ObjectRow.status, "active"),
      isNull(ObjectRow.connectorInstanceId), isNull(ObjectRow.currentRelativePath),
      eq(Version.createdVia, "cloud"), eq(Version.createdByOrgMembershipId, memberId),
      eq(Version.isDeletedVersion, false), isNull(Version.connectorSyncEventId), isNotNull(Version.rawSourceText),
      exists(ownGrant), notExists(sharedGrant), notExists(nonPersonalPluginComponent), notExists(connectedSource),
    )).orderBy(asc(ObjectRow.id)).limit(PERSONAL_SKILLS_MAX_COUNT + 1)

  const bundle: PersonalSkillsBundle = {
    format: PERSONAL_SKILLS_FORMAT,
    version: PERSONAL_SKILLS_VERSION,
    skills: rows.flatMap(({ source }) => source ? [{ source }] : []),
  }
  if (bundle.skills.length > PERSONAL_SKILLS_MAX_COUNT
    || bundle.skills.some(({ source }) => Buffer.byteLength(source, "utf8") > PERSONAL_SKILL_SOURCE_MAX_BYTES)
    || Buffer.byteLength(JSON.stringify(bundle), "utf8") > PERSONAL_SKILLS_MAX_BYTES) {
    throw new PluginArchRouteFailure(413, "personal_skills_bundle_too_large", "Your private skills are too large for a single portable bundle.")
  }
  return bundle
}

export async function importPersonalSkills(context: PluginArchActorContext, bundle: PersonalSkillsBundle) {
  await requirePluginArchCapability(context, "config_object.create")
  await requirePluginArchCapability(context, "plugin.create")

  // Validate every SKILL.md with the standard store rules before any write.
  const skills = bundle.skills.map(({ source }) => {
    if (Buffer.byteLength(source, "utf8") > PERSONAL_SKILL_SOURCE_MAX_BYTES) {
      throw new PluginArchRouteFailure(400, "invalid_skill_source", "Each SKILL.md must fit within 1 MiB.")
    }
    const value = { rawSourceText: source }
    return { title: deriveSkillProjection(value).title, value }
  })

  for (const { title, value } of skills) {
    // Private Cloud skills live in plugins in My Library. A fresh name avoids
    // matching, reusing or writing to any existing plugin, including on retry.
    await createPluginBundle({
      context,
      name: `${title} (copy ${createDenTypeId("plugin").slice(-10)})`,
      components: [{ type: "skill", value }],
    })
  }
  return { created: skills.length }
}
