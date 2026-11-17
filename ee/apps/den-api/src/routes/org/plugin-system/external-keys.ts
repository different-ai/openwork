/**
 * Stable keys of plugins and config objects (skills, agents, commands…).
 *
 * A key is unique per organization and travels with the item in a
 * configuration export, so an import finds the same item again whatever it is
 * called by then. It gets a readable default (a slug of the name) the first
 * time the item is created, exported or imported, and is stored from then on:
 * it is never recomputed and never follows a rename. Admins can change it.
 */
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, PluginTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../../../db.js"
import { isDuplicateEntry } from "../declarative.js"

export type KeyedKind = "plugin" | "config_object"
export type KeyedItem = { kind: KeyedKind; organizationId: string; id: string }

const KEY_MAX = 128
const SUFFIX_TRIES = 20

/** A readable key from a name: `Field notes (v2)` → `field-notes-v2`. Never empty. */
export function externalKeyFromName(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, KEY_MAX - 12)
    .replace(/-+$/, "")
  return slug || "item"
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0")
}

function pluginWhere(item: KeyedItem) {
  return and(eq(PluginTable.organizationId, normalizeDenTypeId("organization", item.organizationId)), eq(PluginTable.id, normalizeDenTypeId("plugin", item.id)))
}

function configObjectWhere(item: KeyedItem) {
  return and(eq(ConfigObjectTable.organizationId, normalizeDenTypeId("organization", item.organizationId)), eq(ConfigObjectTable.id, normalizeDenTypeId("configObject", item.id)))
}

async function writeKey(item: KeyedItem, key: string | null, onlyWhenUnset: boolean): Promise<void> {
  if (item.kind === "plugin") {
    await db.update(PluginTable).set({ externalKey: key }).where(onlyWhenUnset ? and(pluginWhere(item), isNull(PluginTable.externalKey)) : pluginWhere(item))
    return
  }
  await db.update(ConfigObjectTable).set({ externalKey: key }).where(onlyWhenUnset ? and(configObjectWhere(item), isNull(ConfigObjectTable.externalKey)) : configObjectWhere(item))
}

async function readKey(item: KeyedItem): Promise<string | null> {
  if (item.kind === "plugin") {
    const [row] = await db.select({ externalKey: PluginTable.externalKey }).from(PluginTable).where(pluginWhere(item)).limit(1)
    return row?.externalKey ?? null
  }
  const [row] = await db.select({ externalKey: ConfigObjectTable.externalKey }).from(ConfigObjectTable).where(configObjectWhere(item)).limit(1)
  return row?.externalKey ?? null
}

/**
 * Set exactly this key (or clear it with null). False when another item of
 * the organization already has it; nothing is written then.
 */
export async function setExternalKey(item: KeyedItem, key: string | null, options: { onlyWhenUnset?: boolean } = {}): Promise<boolean> {
  try {
    await writeKey(item, key, options.onlyWhenUnset === true)
    return true
  } catch (error) {
    if (isDuplicateEntry(error)) return false
    throw error
  }
}

/**
 * Give an item without a key its default: a slug of the name, with a suffix
 * when another item already has it. Returns the key the item has afterwards
 * (its existing one when it already had a key).
 */
export async function assignDefaultExternalKey(item: KeyedItem, name: string): Promise<string | null> {
  const base = externalKeyFromName(name)
  for (let attempt = 1; attempt <= SUFFIX_TRIES + 3; attempt += 1) {
    const candidate = attempt === 1 ? base : attempt <= SUFFIX_TRIES ? `${base}-${attempt}` : `${base}-${randomSuffix()}`
    if (await setExternalKey(item, candidate, { onlyWhenUnset: true })) return readKey(item)
  }
  return readKey(item)
}
