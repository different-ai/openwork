/**
 * Rollout/rollback control for member-facing org MCP connections.
 *
 * Layer 0 of the rollback story: no deploy, no git revert — flip the per-org
 * flag that ee/apps/den-api/src/capability-sources/external-mcp-rollout.ts
 * reads. Takes effect on the next desktop poll/refresh for every app version
 * in the field.
 *
 * Only meaningful on deployments running with
 * DEN_MCP_CONNECTIONS_GATING_ENABLED=true; without it the feature is on for
 * every org and this flag is ignored.
 *
 * Usage (same env contract as seed:demo-org — DATABASE_URL,
 * DEN_DB_ENCRYPTION_KEY, BETTER_AUTH_SECRET):
 *
 *   pnpm --filter @openwork-ee/den-api exec tsx scripts/mcp-connections-rollout.ts status
 *   pnpm --filter @openwork-ee/den-api exec tsx scripts/mcp-connections-rollout.ts enable <org-slug>
 *   pnpm --filter @openwork-ee/den-api exec tsx scripts/mcp-connections-rollout.ts disable <org-slug>
 *   pnpm --filter @openwork-ee/den-api exec tsx scripts/mcp-connections-rollout.ts dark --yes
 *
 * `disable` removes the org's opt-in. `dark` removes it from every org — the
 * emergency kill switch. Neither touches connections, grants, or member
 * tokens, so re-enabling restores the exact previous state.
 */

import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../src/db.js"
import { env } from "../src/env.js"

const FLAG = "mcpConnectionsEnabled"

function parseMetadata(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === "object" && parsed !== null ? { ...(parsed as Record<string, unknown>) } : {}
    } catch {
      return {}
    }
  }
  return { ...value }
}

async function loadOrg(slug: string) {
  const rows = await db.select().from(OrganizationTable).where(eq(OrganizationTable.slug, slug)).limit(1)
  const org = rows[0]
  if (!org) {
    console.error(`No organization with slug '${slug}'.`)
    process.exit(1)
  }
  return org
}

async function writeFlag(orgId: typeof OrganizationTable.$inferSelect.id, metadata: Record<string, unknown>) {
  await db
    .update(OrganizationTable)
    .set({ metadata: Object.keys(metadata).length > 0 ? metadata : null })
    .where(eq(OrganizationTable.id, orgId))
}

async function status() {
  const rows = await db.select().from(OrganizationTable)
  console.log(`gating env on THIS process: DEN_MCP_CONNECTIONS_GATING_ENABLED=${env.mcpConnectionsGatingEnabled}`)
  console.log("(the deployment's own env is what matters in production)\n")
  for (const org of rows) {
    const enabled = parseMetadata(org.metadata)[FLAG] === true
    console.log(`${enabled ? "ENABLED " : "off     "} ${org.slug}  (${org.name})`)
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2)

  if (command === "status") {
    await status()
    return
  }

  if (command === "enable" || command === "disable") {
    if (!argument) {
      console.error(`Usage: ${command} <org-slug>`)
      process.exit(1)
    }
    const org = await loadOrg(argument)
    const metadata = parseMetadata(org.metadata)
    if (command === "enable") metadata[FLAG] = true
    else delete metadata[FLAG]
    await writeFlag(org.id, metadata)
    console.log(`${command === "enable" ? "Enabled" : "Disabled"} org MCP connections for '${argument}'.`)
    return
  }

  if (command === "dark") {
    if (argument !== "--yes") {
      console.error("This removes the opt-in from EVERY org. Re-run with: dark --yes")
      process.exit(1)
    }
    const rows = await db.select().from(OrganizationTable)
    let changed = 0
    for (const org of rows) {
      const metadata = parseMetadata(org.metadata)
      if (metadata[FLAG] !== true) continue
      delete metadata[FLAG]
      await writeFlag(org.id, metadata)
      changed += 1
      console.log(`  darkened ${org.slug}`)
    }
    console.log(`Done — removed the opt-in from ${changed} org(s).`)
    if (!env.mcpConnectionsGatingEnabled) {
      console.log("WARNING: this process sees DEN_MCP_CONNECTIONS_GATING_ENABLED unset/false.")
      console.log("If production also runs ungated, the feature is STILL live for everyone —")
      console.log("set DEN_MCP_CONNECTIONS_GATING_ENABLED=true on the deployment.")
    }
    return
  }

  console.log("Commands: status | enable <org-slug> | disable <org-slug> | dark --yes")
  process.exit(command ? 1 : 0)
}

await main()
process.exit(0)
