import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  InvitationTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrgSubscriptionTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { auth } from "../src/auth.js"
import { db } from "../src/db.js"
import { ensureDefaultDesktopPolicyForOrganization } from "../src/desktop-policies.js"
import { env } from "../src/env.js"
import { seedDefaultOrganizationRoles } from "../src/orgs.js"
import { calculateOrganizationSeatBillingCounts } from "../src/stripe-billing.js"

const RESET_MODE = process.argv.includes("--reset")

type UserId = typeof AuthUserTable.$inferSelect.id
type OrganizationId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id
type MarketplaceId = typeof MarketplaceTable.$inferSelect.id
type PluginId = typeof PluginTable.$inferSelect.id
type ConfigObjectId = typeof ConfigObjectTable.$inferSelect.id
type ConfigObjectType = typeof ConfigObjectTable.$inferSelect.objectType

type DemoPerson = {
  email: string
  name: string
  role: "admin" | "member" | "owner"
  teams: string[]
}

type DemoPlugin = {
  description: string
  orgWide?: boolean
  slug: string
  teamAccess: string[]
}

type GithubContentEntry = {
  download_url: string | null
  name: string
  path: string
  type: "dir" | "file" | string
}

type PluginContentObject = {
  description: string | null
  normalizedPayloadJson?: Record<string, unknown>
  objectType: ConfigObjectType
  path: string
  rawSourceText: string
  title: string
}

const DEMO_ORG_NAME = process.env.DEN_DEMO_ORG_NAME?.trim() || "Acme Robotics"
const DEMO_ORG_SLUG = process.env.DEN_DEMO_ORG_SLUG?.trim() || "acme-robotics-demo"
const DEMO_EMAIL_DOMAIN = process.env.DEN_DEMO_EMAIL_DOMAIN?.trim() || "acme.test"
const DEMO_OWNER_EMAIL = process.env.DEN_DEMO_OWNER_EMAIL?.trim() || `alex@${DEMO_EMAIL_DOMAIN}`
const DEMO_OWNER_PASSWORD = process.env.DEN_DEMO_OWNER_PASSWORD?.trim() || "OpenWorkDemo123!"
const SHOULD_FETCH_GITHUB = (process.env.DEN_DEMO_SEED_FETCH_GITHUB ?? "1").trim() !== "0"
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim()
const GITHUB_REPO = "anthropics/knowledge-work-plugins"
const GITHUB_REF = process.env.DEN_DEMO_PLUGIN_REF?.trim() || "main"
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_REF}`
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}/contents`
const SOURCE_REVISION_REF = `${GITHUB_REPO}@${GITHUB_REF}`
const MAX_RAW_SOURCE_CHARS = 18_000

const demoPeople: DemoPerson[] = [
  { email: DEMO_OWNER_EMAIL, name: "Alex Chen", role: "owner", teams: ["Leadership", "Product"] },
  { email: `priya@${DEMO_EMAIL_DOMAIN}`, name: "Priya Shah", role: "admin", teams: ["Leadership", "Engineering"] },
  { email: `mateo@${DEMO_EMAIL_DOMAIN}`, name: "Mateo Rivera", role: "admin", teams: ["Leadership", "Sales"] },
  { email: `morgan@${DEMO_EMAIL_DOMAIN}`, name: "Morgan Lee", role: "member", teams: ["Product", "Design"] },
  { email: `nora@${DEMO_EMAIL_DOMAIN}`, name: "Nora Patel", role: "member", teams: ["Product", "Data"] },
  { email: `jamal@${DEMO_EMAIL_DOMAIN}`, name: "Jamal Brooks", role: "member", teams: ["Engineering"] },
  { email: `sofia@${DEMO_EMAIL_DOMAIN}`, name: "Sofia Garcia", role: "member", teams: ["Engineering", "Operations"] },
  { email: `ivy@${DEMO_EMAIL_DOMAIN}`, name: "Ivy Nguyen", role: "member", teams: ["Design"] },
  { email: `liam@${DEMO_EMAIL_DOMAIN}`, name: "Liam O'Connor", role: "member", teams: ["Sales"] },
  { email: `olivia@${DEMO_EMAIL_DOMAIN}`, name: "Olivia Martin", role: "member", teams: ["Sales", "Marketing"] },
  { email: `harper@${DEMO_EMAIL_DOMAIN}`, name: "Harper Wilson", role: "member", teams: ["Support"] },
  { email: `kenji@${DEMO_EMAIL_DOMAIN}`, name: "Kenji Tanaka", role: "member", teams: ["Support", "Operations"] },
  { email: `zoe@${DEMO_EMAIL_DOMAIN}`, name: "Zoe Kim", role: "member", teams: ["Marketing"] },
  { email: `sam@${DEMO_EMAIL_DOMAIN}`, name: "Sam Okafor", role: "member", teams: ["Finance"] },
  { email: `maya@${DEMO_EMAIL_DOMAIN}`, name: "Maya Singh", role: "member", teams: ["Legal"] },
  { email: `ezra@${DEMO_EMAIL_DOMAIN}`, name: "Ezra Cohen", role: "member", teams: ["Data", "Engineering"] },
  { email: `camila@${DEMO_EMAIL_DOMAIN}`, name: "Camila Torres", role: "member", teams: ["Human Resources", "Operations"] },
]

const pendingInvites = [
  { email: `riley@${DEMO_EMAIL_DOMAIN}`, role: "member", team: "Engineering" },
  { email: `taylor@${DEMO_EMAIL_DOMAIN}`, role: "member", team: "Sales" },
  { email: `jordan@${DEMO_EMAIL_DOMAIN}`, role: "admin", team: "Leadership" },
]

const demoPlugins: DemoPlugin[] = [
  {
    description: "Manage tasks, plan your day, and build up memory of important context about your work. Syncs with your calendar, email, and chat to keep everything organized and on track.",
    orgWide: true,
    slug: "productivity",
    teamAccess: ["Leadership", "Operations"],
  },
  {
    description: "Search across all of your company's tools in one place. Find anything across email, chat, documents, and wikis without switching between apps.",
    orgWide: true,
    slug: "enterprise-search",
    teamAccess: ["Leadership", "Product", "Support"],
  },
  {
    description: "Prospect, craft outreach, and build deal strategy faster. Prep for calls, manage your pipeline, and write personalized messaging that moves deals forward.",
    slug: "sales",
    teamAccess: ["Sales", "Marketing"],
  },
  {
    description: "Triage tickets, draft responses, package escalations, research customer context, and turn resolved issues into knowledge base articles.",
    slug: "customer-support",
    teamAccess: ["Support", "Product"],
  },
  {
    description: "Write feature specs, plan roadmaps, and synthesize user research faster. Keep stakeholders updated and stay ahead of the competitive landscape.",
    slug: "product-management",
    teamAccess: ["Product", "Design", "Engineering"],
  },
  {
    description: "Create content, plan campaigns, and analyze performance across marketing channels. Maintain brand voice consistency, track competitors, and report on what's working.",
    slug: "marketing",
    teamAccess: ["Marketing", "Sales"],
  },
  {
    description: "Speed up contract review, NDA triage, and compliance workflows for in-house legal teams. Draft legal briefs, organize precedent research, and manage institutional knowledge.",
    slug: "legal",
    teamAccess: ["Legal", "Leadership"],
  },
  {
    description: "Streamline finance and accounting workflows, from journal entries and reconciliation to financial statements and variance analysis.",
    slug: "finance",
    teamAccess: ["Finance", "Leadership"],
  },
  {
    description: "Write SQL, explore datasets, and generate insights faster. Build visualizations and dashboards, and turn raw data into clear stories for stakeholders.",
    slug: "data",
    teamAccess: ["Data", "Product", "Engineering"],
  },
  {
    description: "Streamline engineering workflows — standups, code review, architecture decisions, incident response, and technical documentation.",
    slug: "engineering",
    teamAccess: ["Engineering", "Product"],
  },
  {
    description: "Accelerate design workflows — critique, design system management, UX writing, accessibility audits, research synthesis, and dev handoff.",
    slug: "design",
    teamAccess: ["Design", "Product"],
  },
  {
    description: "Optimize business operations — vendor management, process documentation, change management, capacity planning, and compliance tracking.",
    slug: "operations",
    teamAccess: ["Operations", "Finance", "Human Resources"],
  },
  {
    description: "Streamline people operations — recruiting, onboarding, performance reviews, compensation analysis, and policy guidance.",
    slug: "human-resources",
    teamAccess: ["Human Resources", "Leadership"],
  },
  {
    description: "View, annotate, and sign PDFs in a live interactive viewer for contracts, forms, and approvals.",
    slug: "pdf-viewer",
    teamAccess: ["Legal", "Finance", "Operations"],
  },
]

function assertSafeDevTarget() {
  if (!env.devMode) {
    throw new Error("Refusing to seed demo data unless OPENWORK_DEV_MODE=1.")
  }
  if (env.dbMode !== "mysql") {
    throw new Error(`Refusing to seed demo data into DB_MODE=${env.dbMode}; use local MySQL dev mode.`)
  }

  const parsed = env.databaseUrl ? new URL(env.databaseUrl) : null
  const host = parsed?.hostname ?? ""
  const allowNonLocal = process.env.DEN_DEMO_SEED_ALLOW_NONLOCAL === "1"
  const localHosts = new Set(["127.0.0.1", "localhost", "mysql"])
  if (!allowNonLocal && !localHosts.has(host)) {
    throw new Error(`Refusing to seed non-local database host '${host}'. Set DEN_DEMO_SEED_ALLOW_NONLOCAL=1 to override.`)
  }
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "openwork-den-demo-seed",
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  if (!SHOULD_FETCH_GITHUB) return null
  try {
    const response = await fetch(url, { headers: githubHeaders() })
    if (!response.ok) return null
    return await response.json() as T
  } catch {
    return null
  }
}

async function fetchText(url: string): Promise<string | null> {
  if (!SHOULD_FETCH_GITHUB) return null
  try {
    const response = await fetch(url, { headers: githubHeaders() })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

function trimForEncryptedText(value: string) {
  if (value.length <= MAX_RAW_SOURCE_CHARS) return value
  return `${value.slice(0, MAX_RAW_SOURCE_CHARS)}\n\n<!-- Demo seed truncated this source file for local DB text column size. -->`
}

function fileNameFromPath(path: string) {
  return path.split("/").pop() ?? path
}

function extensionFromPath(path: string) {
  const fileName = fileNameFromPath(path)
  const dotIndex = fileName.lastIndexOf(".")
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1) : null
}

function titleFromPath(path: string) {
  const fileName = fileNameFromPath(path).replace(/\.[^.]+$/, "")
  return fileName
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || path
}

function deriveSearchText(input: { description?: string | null; rawSourceText?: string | null; title: string }) {
  return [input.title, input.description, input.rawSourceText].filter(Boolean).join("\n") || null
}

async function ensureSignedInOwnerUser() {
  const existing = await db
    .select()
    .from(AuthUserTable)
    .where(eq(AuthUserTable.email, DEMO_OWNER_EMAIL.toLowerCase()))
    .limit(1)

  if (!existing[0]) {
    await (auth.api as unknown as {
      signUpEmail(input: { body: { email: string; name: string; password: string } }): Promise<unknown>
    }).signUpEmail({
      body: {
        email: DEMO_OWNER_EMAIL.toLowerCase(),
        name: demoPeople[0]?.name ?? "Demo Owner",
        password: DEMO_OWNER_PASSWORD,
      },
    })
  }

  const rows = await db
    .select()
    .from(AuthUserTable)
    .where(eq(AuthUserTable.email, DEMO_OWNER_EMAIL.toLowerCase()))
    .limit(1)
  const user = rows[0]
  if (!user) throw new Error(`Failed to create demo owner ${DEMO_OWNER_EMAIL}.`)

  await db
    .update(AuthUserTable)
    .set({ emailVerified: true, name: demoPeople[0]?.name ?? user.name, updatedAt: new Date() })
    .where(eq(AuthUserTable.id, user.id))

  return user.id
}

async function ensureDisplayUser(person: DemoPerson): Promise<UserId> {
  if (person.email.toLowerCase() === DEMO_OWNER_EMAIL.toLowerCase()) {
    return ensureSignedInOwnerUser()
  }

  const email = person.email.toLowerCase()
  const existing = await db.select().from(AuthUserTable).where(eq(AuthUserTable.email, email)).limit(1)
  if (existing[0]) {
    await db
      .update(AuthUserTable)
      .set({ emailVerified: true, name: person.name, updatedAt: new Date() })
      .where(eq(AuthUserTable.id, existing[0].id))
    return existing[0].id
  }

  const id = createDenTypeId("user")
  const now = new Date()
  await db.insert(AuthUserTable).values({
    createdAt: now,
    email,
    emailVerified: true,
    id,
    image: null,
    name: person.name,
    updatedAt: now,
  })
  return id
}

async function ensureOrganization(ownerUserId: UserId): Promise<OrganizationId> {
  const existing = await db.select().from(OrganizationTable).where(eq(OrganizationTable.slug, DEMO_ORG_SLUG)).limit(1)
  const metadata = {
    demoSeed: {
      source: "den-api seed:demo-org",
      updatedAt: new Date().toISOString(),
    },
    limits: {
      members: 100,
      workers: 0,
    },
  }

  if (existing[0]) {
    await db
      .update(OrganizationTable)
      .set({
        allowedEmailDomains: [DEMO_EMAIL_DOMAIN],
        metadata,
        name: DEMO_ORG_NAME,
        updatedAt: new Date(),
      })
      .where(eq(OrganizationTable.id, existing[0].id))
    await seedDefaultOrganizationRoles(existing[0].id)
    const ownerMemberId = await ensureMember(existing[0].id, ownerUserId, "owner")
    await ensureDefaultDesktopPolicyForOrganization({
      organizationId: existing[0].id,
      createdByOrgMemberId: ownerMemberId,
    })
    return existing[0].id
  }

  const id = createDenTypeId("organization")
  await db.insert(OrganizationTable).values({
    allowedEmailDomains: [DEMO_EMAIL_DOMAIN],
    id,
    logo: null,
    metadata,
    name: DEMO_ORG_NAME,
    slug: DEMO_ORG_SLUG,
  })
  await seedDefaultOrganizationRoles(id)
  const ownerMemberId = await ensureMember(id, ownerUserId, "owner")
  await ensureDefaultDesktopPolicyForOrganization({
    organizationId: id,
    createdByOrgMemberId: ownerMemberId,
  })
  return id
}

async function ensureMember(organizationId: OrganizationId, userId: UserId, role: DemoPerson["role"]): Promise<MemberId> {
  const existing = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId)))
    .limit(1)

  if (existing[0]) {
    await db.update(MemberTable).set({ role }).where(eq(MemberTable.id, existing[0].id))
    return existing[0].id
  }

  const id = createDenTypeId("member")
  await db.insert(MemberTable).values({ id, organizationId, role, userId })
  return id
}

async function ensureTeam(organizationId: OrganizationId, name: string): Promise<TeamId> {
  const existing = await db
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.name, name)))
    .limit(1)
  if (existing[0]) return existing[0].id

  const id = createDenTypeId("team")
  await db.insert(TeamTable).values({ id, name, organizationId })
  return id
}

async function ensureTeamMember(teamId: TeamId, orgMembershipId: MemberId) {
  const existing = await db
    .select()
    .from(TeamMemberTable)
    .where(and(eq(TeamMemberTable.teamId, teamId), eq(TeamMemberTable.orgMembershipId, orgMembershipId)))
    .limit(1)
  if (existing[0]) return existing[0].id

  const id = createDenTypeId("teamMember")
  await db.insert(TeamMemberTable).values({ id, orgMembershipId, teamId })
  return id
}

async function ensureDemoSeatSubscription(input: { createdByOrgMembershipId: MemberId; memberCount: number; organizationId: OrganizationId }) {
  const now = new Date()
  const currentPeriodEnd = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30)
  const quantity = calculateOrganizationSeatBillingCounts({ memberCount: input.memberCount }).chargeable
  await db.insert(OrgSubscriptionTable).values({
    cancel_at_period_end: false,
    canceled_at: null,
    created_at: now,
    created_by_org_membership_id: input.createdByOrgMembershipId,
    current_period_end: currentPeriodEnd,
    current_period_start: now,
    ended_at: null,
    id: createDenTypeId("orgSubscription"),
    last_event_id: "demo-seed-seat-subscription",
    organization_id: input.organizationId,
    quantity,
    status: "active",
    stripe_customer_id: `cus_demo_${input.organizationId}`,
    stripe_price_id: "price_demo_seats",
    stripe_subscription_id: `sub_demo_seats_${input.organizationId}`,
    stripe_subscription_item_id: null,
    type: "seat",
    updated_at: now,
  }).onDuplicateKeyUpdate({
    set: {
      cancel_at_period_end: false,
      canceled_at: null,
      created_by_org_membership_id: input.createdByOrgMembershipId,
      current_period_end: currentPeriodEnd,
      current_period_start: now,
      ended_at: null,
      last_event_id: "demo-seed-seat-subscription",
      quantity,
      status: "active",
      stripe_customer_id: `cus_demo_${input.organizationId}`,
      stripe_price_id: "price_demo_seats",
      stripe_subscription_id: `sub_demo_seats_${input.organizationId}`,
      stripe_subscription_item_id: null,
      updated_at: now,
    },
  })
}

async function ensureInvitation(input: {
  email: string
  inviterId: UserId
  organizationId: OrganizationId
  role: string
  teamId: TeamId | null
}) {
  const email = input.email.toLowerCase()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14)
  const existing = await db
    .select()
    .from(InvitationTable)
    .where(and(eq(InvitationTable.organizationId, input.organizationId), eq(InvitationTable.email, email)))
    .limit(1)

  if (existing[0]) {
    await db
      .update(InvitationTable)
      .set({ expiresAt, inviterId: input.inviterId, role: input.role, status: "pending", teamId: input.teamId })
      .where(eq(InvitationTable.id, existing[0].id))
    return existing[0].id
  }

  const id = createDenTypeId("invitation")
  await db.insert(InvitationTable).values({
    email,
    expiresAt,
    id,
    inviterId: input.inviterId,
    organizationId: input.organizationId,
    role: input.role,
    status: "pending",
    teamId: input.teamId,
  })
  return id
}

async function ensureMarketplace(input: { createdByOrgMembershipId: MemberId; organizationId: OrganizationId }): Promise<MarketplaceId> {
  const name = "Anthropic Knowledge Work Plugins"
  const description = `Demo marketplace seeded from ${GITHUB_REPO}. Plugins are imported into Den DB for local demos; no external integrations are connected.`
  const logoUrl = "https://cdn.simpleicons.org/anthropic"
  const existing = await db
    .select()
    .from(MarketplaceTable)
    .where(and(eq(MarketplaceTable.organizationId, input.organizationId), eq(MarketplaceTable.name, name)))
    .limit(1)

  if (existing[0]) {
    await db
      .update(MarketplaceTable)
      .set({ createdByOrgMembershipId: input.createdByOrgMembershipId, deletedAt: null, description, logoUrl, status: "active", updatedAt: new Date() })
      .where(eq(MarketplaceTable.id, existing[0].id))
    await ensureMarketplaceAccessGrant({ ...input, marketplaceId: existing[0].id, role: "viewer" })
    return existing[0].id
  }

  const id = createDenTypeId("marketplace")
  await db.insert(MarketplaceTable).values({
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    deletedAt: null,
    description,
    id,
    logoUrl,
    name,
    organizationId: input.organizationId,
    status: "active",
  })
  await ensureMarketplaceAccessGrant({ ...input, marketplaceId: id, role: "viewer" })
  return id
}

async function ensureMarketplaceAccessGrant(input: {
  createdByOrgMembershipId: MemberId
  marketplaceId: MarketplaceId
  organizationId: OrganizationId
  role: "manager" | "viewer"
}) {
  const existing = await db
    .select()
    .from(MarketplaceAccessGrantTable)
    .where(and(eq(MarketplaceAccessGrantTable.marketplaceId, input.marketplaceId), eq(MarketplaceAccessGrantTable.orgWide, true)))
    .limit(1)
  if (existing[0]) {
    await db
      .update(MarketplaceAccessGrantTable)
      .set({ createdByOrgMembershipId: input.createdByOrgMembershipId, orgWide: true, removedAt: null, role: input.role })
      .where(eq(MarketplaceAccessGrantTable.id, existing[0].id))
    return existing[0].id
  }

  const id = createDenTypeId("marketplaceAccessGrant")
  await db.insert(MarketplaceAccessGrantTable).values({
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    id,
    marketplaceId: input.marketplaceId,
    organizationId: input.organizationId,
    orgMembershipId: null,
    orgWide: true,
    role: input.role,
    teamId: null,
  })
  return id
}

async function ensurePlugin(input: {
  createdByOrgMembershipId: MemberId
  marketplaceId: MarketplaceId
  organizationId: OrganizationId
  plugin: DemoPlugin
}): Promise<PluginId> {
  const existing = await db
    .select()
    .from(PluginTable)
    .where(and(eq(PluginTable.organizationId, input.organizationId), eq(PluginTable.name, input.plugin.slug)))
    .limit(1)

  const description = `${input.plugin.description}\n\nSource: https://github.com/${GITHUB_REPO}/tree/${GITHUB_REF}/${input.plugin.slug}`
  let pluginId: PluginId
  if (existing[0]) {
    pluginId = existing[0].id
    await db
      .update(PluginTable)
      .set({ createdByOrgMembershipId: input.createdByOrgMembershipId, deletedAt: null, description, name: input.plugin.slug, status: "active", updatedAt: new Date() })
      .where(eq(PluginTable.id, pluginId))
  } else {
    pluginId = createDenTypeId("plugin")
    await db.insert(PluginTable).values({
      createdByOrgMembershipId: input.createdByOrgMembershipId,
      deletedAt: null,
      description,
      id: pluginId,
      name: input.plugin.slug,
      organizationId: input.organizationId,
      status: "active",
    })
  }

  await ensureMarketplacePlugin({ ...input, pluginId })
  return pluginId
}

async function ensureMarketplacePlugin(input: {
  createdByOrgMembershipId: MemberId
  marketplaceId: MarketplaceId
  organizationId: OrganizationId
  pluginId: PluginId
}) {
  const existing = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), eq(MarketplacePluginTable.pluginId, input.pluginId)))
    .limit(1)

  if (existing[0]) {
    await db
      .update(MarketplacePluginTable)
      .set({ createdByOrgMembershipId: input.createdByOrgMembershipId, membershipSource: "system", removedAt: null })
      .where(eq(MarketplacePluginTable.id, existing[0].id))
    return existing[0].id
  }

  const id = createDenTypeId("marketplacePlugin")
  await db.insert(MarketplacePluginTable).values({
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    id,
    marketplaceId: input.marketplaceId,
    membershipSource: "system",
    organizationId: input.organizationId,
    pluginId: input.pluginId,
    removedAt: null,
  })
  return id
}

async function ensurePluginAccessGrant(input: {
  createdByOrgMembershipId: MemberId
  organizationId: OrganizationId
  pluginId: PluginId
  role: "editor" | "manager" | "viewer"
  teamId?: TeamId | null
  orgWide?: boolean
}) {
  const existing = await db
    .select()
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.pluginId, input.pluginId),
      input.teamId ? eq(PluginAccessGrantTable.teamId, input.teamId) : eq(PluginAccessGrantTable.orgWide, true),
    ))
    .limit(1)

  if (existing[0]) {
    await db
      .update(PluginAccessGrantTable)
      .set({
        createdByOrgMembershipId: input.createdByOrgMembershipId,
        orgMembershipId: null,
        orgWide: input.orgWide ?? !input.teamId,
        removedAt: null,
        role: input.role,
        teamId: input.teamId ?? null,
      })
      .where(eq(PluginAccessGrantTable.id, existing[0].id))
    return existing[0].id
  }

  const id = createDenTypeId("pluginAccessGrant")
  await db.insert(PluginAccessGrantTable).values({
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    id,
    organizationId: input.organizationId,
    orgMembershipId: null,
    orgWide: input.orgWide ?? !input.teamId,
    pluginId: input.pluginId,
    role: input.role,
    teamId: input.teamId ?? null,
  })
  return id
}

async function ensureConfigObject(input: {
  createdByOrgMembershipId: MemberId
  object: PluginContentObject
  organizationId: OrganizationId
  pluginId: PluginId
}) {
  const currentFileName = fileNameFromPath(input.object.path)
  const currentFileExtension = extensionFromPath(input.object.path)
  const rawSourceText = trimForEncryptedText(input.object.rawSourceText)
  const searchText = deriveSearchText({ description: input.object.description, rawSourceText, title: input.object.title })

  const existing = await db
    .select()
    .from(ConfigObjectTable)
    .where(and(eq(ConfigObjectTable.organizationId, input.organizationId), eq(ConfigObjectTable.currentRelativePath, input.object.path)))
    .limit(1)

  let configObjectId: ConfigObjectId
  if (existing[0]) {
    configObjectId = existing[0].id
    await db
      .update(ConfigObjectTable)
      .set({
        createdByOrgMembershipId: input.createdByOrgMembershipId,
        currentFileExtension,
        currentFileName,
        currentRelativePath: input.object.path,
        deletedAt: null,
        description: input.object.description,
        objectType: input.object.objectType,
        searchText,
        sourceMode: "import",
        status: "active",
        title: input.object.title,
        updatedAt: new Date(),
      })
      .where(eq(ConfigObjectTable.id, configObjectId))
  } else {
    configObjectId = createDenTypeId("configObject")
    await db.insert(ConfigObjectTable).values({
      connectorInstanceId: null,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
      currentFileExtension,
      currentFileName,
      currentRelativePath: input.object.path,
      deletedAt: null,
      description: input.object.description,
      id: configObjectId,
      objectType: input.object.objectType,
      organizationId: input.organizationId,
      searchText,
      sourceMode: "import",
      status: "active",
      title: input.object.title,
    })
  }

  await db.insert(ConfigObjectVersionTable).values({
    configObjectId,
    connectorSyncEventId: null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    createdVia: "import",
    id: createDenTypeId("configObjectVersion"),
    isDeletedVersion: false,
    normalizedPayloadJson: input.object.normalizedPayloadJson ?? null,
    organizationId: input.organizationId,
    rawSourceText,
    schemaVersion: "claude-plugin/demo-seed-v1",
    sourceRevisionRef: SOURCE_REVISION_REF,
  })

  await ensureConfigObjectAccessGrant({
    configObjectId,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    organizationId: input.organizationId,
  })
  await ensurePluginConfigObject({
    configObjectId,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    organizationId: input.organizationId,
    pluginId: input.pluginId,
  })
}

async function ensureConfigObjectAccessGrant(input: {
  configObjectId: ConfigObjectId
  createdByOrgMembershipId: MemberId
  organizationId: OrganizationId
}) {
  const existing = await db
    .select()
    .from(ConfigObjectAccessGrantTable)
    .where(and(eq(ConfigObjectAccessGrantTable.configObjectId, input.configObjectId), eq(ConfigObjectAccessGrantTable.orgWide, true)))
    .limit(1)
  if (existing[0]) {
    await db
      .update(ConfigObjectAccessGrantTable)
      .set({ createdByOrgMembershipId: input.createdByOrgMembershipId, orgWide: true, removedAt: null, role: "viewer" })
      .where(eq(ConfigObjectAccessGrantTable.id, existing[0].id))
    return existing[0].id
  }
  const id = createDenTypeId("configObjectAccessGrant")
  await db.insert(ConfigObjectAccessGrantTable).values({
    configObjectId: input.configObjectId,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    id,
    organizationId: input.organizationId,
    orgMembershipId: null,
    orgWide: true,
    role: "viewer",
    teamId: null,
  })
  return id
}

async function ensurePluginConfigObject(input: {
  configObjectId: ConfigObjectId
  createdByOrgMembershipId: MemberId
  organizationId: OrganizationId
  pluginId: PluginId
}) {
  const existing = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, input.configObjectId)))
    .limit(1)
  if (existing[0]) {
    await db
      .update(PluginConfigObjectTable)
      .set({ createdByOrgMembershipId: input.createdByOrgMembershipId, membershipSource: "system", removedAt: null })
      .where(eq(PluginConfigObjectTable.id, existing[0].id))
    return existing[0].id
  }
  const id = createDenTypeId("pluginConfigObject")
  await db.insert(PluginConfigObjectTable).values({
    configObjectId: input.configObjectId,
    connectorMappingId: null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    id,
    membershipSource: "system",
    organizationId: input.organizationId,
    pluginId: input.pluginId,
    removedAt: null,
  })
  return id
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

async function fetchContents(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/")
  const response = await fetchJson<GithubContentEntry[] | GithubContentEntry>(`${GITHUB_API_BASE}/${encoded}?ref=${encodeURIComponent(GITHUB_REF)}`)
  return Array.isArray(response) ? response : []
}

async function fetchPluginContent(plugin: DemoPlugin): Promise<PluginContentObject[]> {
  const objects: PluginContentObject[] = []
  const manifestPath = `${plugin.slug}/.claude-plugin/plugin.json`
  const manifestRaw = await fetchText(`${GITHUB_RAW_BASE}/${manifestPath}`)
  objects.push({
    description: "Claude-compatible plugin manifest imported for the local Den demo.",
    normalizedPayloadJson: manifestRaw ? parseJsonObject(manifestRaw) : { name: plugin.slug, description: plugin.description },
    objectType: "context",
    path: manifestPath,
    rawSourceText: manifestRaw ?? JSON.stringify({ name: plugin.slug, description: plugin.description, source: `${GITHUB_REPO}/${plugin.slug}` }, null, 2),
    title: `${plugin.slug} manifest`,
  })

  const mcpPath = `${plugin.slug}/.mcp.json`
  const mcpRaw = await fetchText(`${GITHUB_RAW_BASE}/${mcpPath}`)
  if (mcpRaw) {
    objects.push({
      description: "MCP connector manifest stored as plugin configuration only; demo seed does not create active connector accounts.",
      normalizedPayloadJson: parseJsonObject(mcpRaw),
      objectType: "mcp",
      path: mcpPath,
      rawSourceText: mcpRaw,
      title: `${plugin.slug} MCP manifest`,
    })
  } else {
    objects.push({
      description: "Demo MCP placeholder showing where connector configuration would live without connecting any integration.",
      normalizedPayloadJson: { mcpServers: {}, demoOnly: true, source: `${GITHUB_REPO}/${plugin.slug}` },
      objectType: "mcp",
      path: `${plugin.slug}/.mcp.demo.json`,
      rawSourceText: JSON.stringify({ mcpServers: {}, demoOnly: true, source: `${GITHUB_REPO}/${plugin.slug}` }, null, 2),
      title: `${plugin.slug} MCP manifest`,
    })
  }

  const skillEntries = (await fetchContents(`${plugin.slug}/skills`))
    .filter((entry) => entry.type === "dir" || entry.name.toLowerCase() === "skill.md")
    .slice(0, 3)

  for (const entry of skillEntries) {
    const skillPath = entry.type === "dir" ? `${entry.path}/SKILL.md` : entry.path
    const raw = await fetchText(`${GITHUB_RAW_BASE}/${skillPath}`)
    if (!raw) continue
    objects.push({
      description: `Real skill source from ${GITHUB_REPO}/${skillPath}.`,
      objectType: "skill",
      path: skillPath,
      rawSourceText: raw,
      title: titleFromPath(entry.type === "dir" ? entry.path : skillPath),
    })
  }

  const commandEntries = (await fetchContents(`${plugin.slug}/commands`))
    .filter((entry) => entry.type === "file" && /\.(md|mdx)$/i.test(entry.name))
    .slice(0, 2)

  for (const entry of commandEntries) {
    const raw = await fetchText(`${GITHUB_RAW_BASE}/${entry.path}`)
    if (!raw) continue
    objects.push({
      description: `Real command source from ${GITHUB_REPO}/${entry.path}.`,
      objectType: "command",
      path: entry.path,
      rawSourceText: raw,
      title: titleFromPath(entry.path),
    })
  }

  if (!objects.some((object) => object.objectType === "skill")) {
    objects.push({
      description: "Demo fallback skill generated from the real marketplace description.",
      objectType: "skill",
      path: `${plugin.slug}/skills/demo-overview/SKILL.md`,
      rawSourceText: `# ${plugin.slug} overview\n\n${plugin.description}\n\nSource: https://github.com/${GITHUB_REPO}/tree/${GITHUB_REF}/${plugin.slug}\n\nThis fallback is used when GitHub source fetching is unavailable during local seeding.`,
      title: `${plugin.slug} overview`,
    })
  }

  return objects
}

function log(icon: string, message: string) {
  console.log(`  ${icon} ${message}`)
}

async function resetDemoOrg() {
  const existing = await db.select().from(OrganizationTable).where(eq(OrganizationTable.slug, DEMO_ORG_SLUG)).limit(1)
  if (!existing[0]) {
    log("⊘", "no existing demo org to reset")
    return
  }
  const orgId = existing[0].id
  log("↻", `resetting demo org ${orgId}…`)

  const pluginIds = (await db.select({ id: PluginTable.id }).from(PluginTable).where(eq(PluginTable.organizationId, orgId))).map((r) => r.id)
  const marketplaceIds = (await db.select({ id: MarketplaceTable.id }).from(MarketplaceTable).where(eq(MarketplaceTable.organizationId, orgId))).map((r) => r.id)
  const configObjectIds = (await db.select({ id: ConfigObjectTable.id }).from(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, orgId))).map((r) => r.id)

  if (configObjectIds.length > 0) {
    await db.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
    await db.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.configObjectId, configObjectIds))
    await db.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds))
    await db.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.id, configObjectIds))
  }
  if (pluginIds.length > 0) {
    await db.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.pluginId, pluginIds))
    await db.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.pluginId, pluginIds))
    await db.delete(PluginTable).where(inArray(PluginTable.id, pluginIds))
  }
  if (marketplaceIds.length > 0) {
    await db.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds))
    await db.delete(MarketplaceTable).where(inArray(MarketplaceTable.id, marketplaceIds))
  }
  await db.delete(OrgSubscriptionTable).where(eq(OrgSubscriptionTable.organization_id, orgId))
  await db.delete(InvitationTable).where(eq(InvitationTable.organizationId, orgId))
  await db.delete(TeamMemberTable).where(inArray(TeamMemberTable.teamId, (await db.select({ id: TeamTable.id }).from(TeamTable).where(eq(TeamTable.organizationId, orgId))).map((r) => r.id)))
  await db.delete(TeamTable).where(eq(TeamTable.organizationId, orgId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, orgId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, orgId))
  log("✓", "demo org data deleted")
}

async function seedPeopleAndTeams(organizationId: OrganizationId) {
  const userIdsByEmail = new Map<string, UserId>()
  const memberIdsByEmail = new Map<string, MemberId>()
  const teamIdsByName = new Map<string, TeamId>()

  for (const person of demoPeople) {
    const userId = await ensureDisplayUser(person)
    userIdsByEmail.set(person.email.toLowerCase(), userId)
    const memberId = await ensureMember(organizationId, userId, person.role)
    memberIdsByEmail.set(person.email.toLowerCase(), memberId)
  }

  for (const teamName of [...new Set(demoPeople.flatMap((person) => person.teams).concat(pendingInvites.map((invite) => invite.team)))]) {
    teamIdsByName.set(teamName, await ensureTeam(organizationId, teamName))
  }

  for (const person of demoPeople) {
    const memberId = memberIdsByEmail.get(person.email.toLowerCase())
    if (!memberId) continue
    for (const teamName of person.teams) {
      const teamId = teamIdsByName.get(teamName)
      if (teamId) await ensureTeamMember(teamId, memberId)
    }
  }

  const ownerUserId = userIdsByEmail.get(DEMO_OWNER_EMAIL.toLowerCase())
  if (!ownerUserId) throw new Error("Demo owner user missing after seed.")
  for (const invite of pendingInvites) {
    await ensureInvitation({
      email: invite.email,
      inviterId: ownerUserId,
      organizationId,
      role: invite.role,
      teamId: teamIdsByName.get(invite.team) ?? null,
    })
  }

  return { memberIdsByEmail, teamIdsByName, userIdsByEmail }
}

async function seedPlugins(input: {
  createdByOrgMembershipId: MemberId
  marketplaceId: MarketplaceId
  organizationId: OrganizationId
  teamIdsByName: Map<string, TeamId>
}) {
  let seededPlugins = 0
  let seededObjects = 0
  for (const plugin of demoPlugins) {
    const pluginId = await ensurePlugin({ ...input, plugin })
    if (plugin.orgWide) {
      await ensurePluginAccessGrant({ ...input, orgWide: true, pluginId, role: "viewer" })
    }
    for (const teamName of plugin.teamAccess) {
      const teamId = input.teamIdsByName.get(teamName)
      if (teamId) {
        await ensurePluginAccessGrant({ ...input, pluginId, role: "editor", teamId })
      }
    }

    const contentObjects = await fetchPluginContent(plugin)
    for (const object of contentObjects) {
      await ensureConfigObject({
        createdByOrgMembershipId: input.createdByOrgMembershipId,
        object,
        organizationId: input.organizationId,
        pluginId,
      })
      seededObjects++
    }
    seededPlugins++
    log("✓", `plugin ${seededPlugins}/${demoPlugins.length}: ${plugin.slug} (${contentObjects.length} objects)`)
  }
  return { seededObjects, seededPlugins }
}

async function main() {
  assertSafeDevTarget()
  const startMs = Date.now()

  console.log()
  console.log(`  den demo seed · ${DEMO_ORG_NAME}`)
  console.log(`  ${"─".repeat(40)}`)
  log("◈", `org slug: ${DEMO_ORG_SLUG}`)
  log("◈", `database: ${env.databaseUrl?.replace(/:[^@]*@/, ":***@") ?? "unknown"}`)
  log("◈", `github fetch: ${SHOULD_FETCH_GITHUB ? "enabled" : "disabled"}`)
  if (RESET_MODE) log("◈", "reset mode: will delete existing demo org first")
  console.log()

  if (RESET_MODE) {
    await resetDemoOrg()
    console.log()
  }

  log("…", "creating owner account")
  const ownerUserId = await ensureSignedInOwnerUser()
  log("✓", `owner: ${DEMO_OWNER_EMAIL}`)

  log("…", "creating organization")
  const organizationId = await ensureOrganization(ownerUserId)
  log("✓", `org: ${organizationId}`)
  console.log()

  log("…", `seeding ${demoPeople.length} users and teams`)
  const { memberIdsByEmail, teamIdsByName } = await seedPeopleAndTeams(organizationId)
  log("✓", `${memberIdsByEmail.size} members · ${teamIdsByName.size} teams · ${pendingInvites.length} pending invites`)
  console.log()

  const ownerMembershipId = memberIdsByEmail.get(DEMO_OWNER_EMAIL.toLowerCase())
  if (!ownerMembershipId) throw new Error("Demo owner membership missing after seed.")

  await ensureDemoSeatSubscription({ createdByOrgMembershipId: ownerMembershipId, memberCount: memberIdsByEmail.size, organizationId })
  log("✓", "active demo seat subscription")
  console.log()

  log("…", "creating marketplace")
  const marketplaceId = await ensureMarketplace({ createdByOrgMembershipId: ownerMembershipId, organizationId })
  log("✓", `marketplace: ${marketplaceId}`)
  console.log()

  log("…", `seeding ${demoPlugins.length} plugins`)
  const { seededObjects, seededPlugins } = await seedPlugins({ createdByOrgMembershipId: ownerMembershipId, marketplaceId, organizationId, teamIdsByName })
  console.log()

  const elapsedSeconds = ((Date.now() - startMs) / 1000).toFixed(1)
  console.log(`  ${"─".repeat(40)}`)
  log("✓", `done in ${elapsedSeconds}s`)
  log(" ", `${memberIdsByEmail.size} members · ${teamIdsByName.size} teams · ${seededPlugins} plugins · ${seededObjects} config objects`)
  console.log()
  log("→", `login: ${DEMO_OWNER_EMAIL} / ${DEMO_OWNER_PASSWORD}`)
  log("→", "open: /organization or /dashboard")
  console.log()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
