import { createHash } from "node:crypto"

/**
 * Instance naming doubles as the create idempotency key. Names are DNS-label
 * safe (lowercase slug, 63 chars) so every host can use them verbatim.
 */
export function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function workerHint(workerId: string) {
  return workerId.replace(/-/g, "").slice(0, 12)
}

export type InstanceNameInput = {
  workerId: string
  name: string
}

function hash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

function opaqueInstanceName(prefix: string, input: InstanceNameInput, version: string | null, recoverySuffix?: string) {
  const identity = hash(input.workerId, 32)
  const imageTag = version ? `-v${hash(version, 8)}` : ""
  const recoveryTag = recoverySuffix === undefined ? "" : `-r${hash(recoverySuffix, 8)}`
  const tail = `${identity}${imageTag}${recoveryTag}`
  // Only the prefix may shrink; the full worker hash and lifecycle tags must survive.
  const safePrefix = slug(prefix).slice(0, 63 - tail.length - 1).replace(/-$/, "")
  return safePrefix ? `${safePrefix}-${tail}` : tail
}

export function baseInstanceName(prefix: string, input: InstanceNameInput) {
  return opaqueInstanceName(prefix, input, null)
}

export function instanceNameForImageVersion(prefix: string, input: InstanceNameInput, version: string) {
  return opaqueInstanceName(prefix, input, version)
}

// Preserve the original computations only for finding already-created instances.
function legacyBaseInstanceName(prefix: string, input: InstanceNameInput) {
  return slug(`${prefix}-${input.name}-${workerHint(input.workerId)}`).slice(0, 63)
}

function shortImageVersion(version: string) {
  return slug(version).slice(0, 24) || "snapshot"
}

function legacyInstanceNameForImageVersion(prefix: string, input: InstanceNameInput, version: string) {
  const shortVersion = shortImageVersion(version)
  const base = legacyBaseInstanceName(prefix, input)
  const baseLength = Math.max(1, 63 - shortVersion.length - 1)
  return slug(`${base.slice(0, baseLength)}-${shortVersion}`).slice(0, 63)
}

/** The name a new instance gets today: version-qualified when an image is pinned. */
export function currentInstanceName(prefix: string, input: InstanceNameInput, version: string | null) {
  return version ? instanceNameForImageVersion(prefix, input, version) : baseInstanceName(prefix, input)
}

/** Current name first, then the unversioned name and both legacy forms. */
export function instanceLookupNames(prefix: string, input: InstanceNameInput, version: string | null) {
  const names: string[] = []
  const legacyBase = legacyBaseInstanceName(prefix, input)
  const legacyVersioned = version ? legacyInstanceNameForImageVersion(prefix, input, version) : legacyBase
  for (const name of [currentInstanceName(prefix, input, version), baseInstanceName(prefix, input), legacyVersioned, legacyBase]) {
    if (!names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

export function recoveryInstanceName(prefix: string, input: InstanceNameInput, version: string | null, suffix: string) {
  return opaqueInstanceName(prefix, input, version, suffix)
}
