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

export function baseInstanceName(prefix: string, input: InstanceNameInput) {
  return slug(`${prefix}-${input.name}-${workerHint(input.workerId)}`).slice(0, 63)
}

function shortImageVersion(version: string) {
  return slug(version).slice(0, 24) || "snapshot"
}

export function instanceNameForImageVersion(prefix: string, input: InstanceNameInput, version: string) {
  const shortVersion = shortImageVersion(version)
  const base = baseInstanceName(prefix, input)
  const baseLength = Math.max(1, 63 - shortVersion.length - 1)
  return slug(`${base.slice(0, baseLength)}-${shortVersion}`).slice(0, 63)
}

/** The name a new instance gets today: version-qualified when an image is pinned. */
export function currentInstanceName(prefix: string, input: InstanceNameInput, version: string | null) {
  return version ? instanceNameForImageVersion(prefix, input, version) : baseInstanceName(prefix, input)
}

/** Current name first, then the pre-versioning name existing workers may still carry. */
export function instanceLookupNames(prefix: string, input: InstanceNameInput, version: string | null) {
  const names: string[] = []
  for (const name of [currentInstanceName(prefix, input, version), baseInstanceName(prefix, input)]) {
    if (!names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

export function recoveryInstanceName(prefix: string, input: InstanceNameInput, version: string | null, suffix: string) {
  const base = currentInstanceName(prefix, input, version)
  const baseLength = Math.max(1, 63 - suffix.length - 10)
  return slug(`${base.slice(0, baseLength)}-recovery-${suffix}`).slice(0, 63)
}
