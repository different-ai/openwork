export type MigrationJournalEntry = {
  idx: number
  when: number
  tag: string
}

/**
 * A non-empty database without a ledger predates reliable migration tracking.
 * Never assume it already contains 0040: that migration must be inspected and
 * applied by the schema-aware repair step before it is recorded.
 */
export const LEGACY_BASELINE_THROUGH_TAG = "0039_bouncy_chamber"
export const LATEST_BASELINE_ALIAS = "latest"
/**
 * Drizzle Kit deliberately ignores its own ledger while introspecting for
 * `push`. A zero-timestamp row therefore gives an empty-database bootstrap a
 * durable, crash-safe marker without introducing an unknown application table.
 * Real migration timestamps are positive, so the marker never advances the
 * migration cursor.
 */
export const FRESH_BOOTSTRAP_SENTINEL_HASH = "openwork:fresh-bootstrap:v1"
export const FRESH_BOOTSTRAP_SENTINEL_CREATED_AT = 0

export type BootstrapMigrationPlan = {
  applyCurrentSchema: boolean
  baselineThrough: string | null
  createFreshBootstrapSentinel: boolean
  verifyLegacySnapshot: boolean
}

/**
 * Decide the only state-based step bootstrap may take before normal
 * migrations. Fresh installs are pushed to the current schema and can be
 * explicitly baselined through latest. Legacy schemas must stop at the last
 * known pre-0040 revision so the schema-aware 0040 repair can inspect them.
 */
export function resolveBootstrapMigrationPlan(input: {
  applicationTableCount: number
  recordedMigrationCount: number
  freshBootstrapSentinelPresent: boolean
}): BootstrapMigrationPlan {
  // The sentinel is cleared only after the state push and complete baseline.
  // It therefore takes precedence even if a baseline process wrote some (or
  // all) migration rows before being interrupted.
  if (input.freshBootstrapSentinelPresent) {
    return {
      applyCurrentSchema: true,
      baselineThrough: LATEST_BASELINE_ALIAS,
      createFreshBootstrapSentinel: false,
      verifyLegacySnapshot: false,
    }
  }

  if (input.recordedMigrationCount > 0) {
    if (input.applicationTableCount === 0) {
      throw new Error("Migration history exists but the application schema is empty; refusing to overwrite it.")
    }
    return {
      applyCurrentSchema: false,
      baselineThrough: null,
      createFreshBootstrapSentinel: false,
      verifyLegacySnapshot: false,
    }
  }

  if (input.applicationTableCount === 0) {
    return {
      applyCurrentSchema: true,
      baselineThrough: LATEST_BASELINE_ALIAS,
      createFreshBootstrapSentinel: !input.freshBootstrapSentinelPresent,
      verifyLegacySnapshot: false,
    }
  }

  // This is a no-ledger schema that bootstrap did not itself start from empty.
  // It may be a legitimate state-managed deployment, an older deployment, or
  // a partial install from before the sentinel existed. The caller must prove
  // every 0037 object exists before it records that history.
  return {
    applyCurrentSchema: false,
    baselineThrough: LEGACY_BASELINE_THROUGH_TAG,
    createFreshBootstrapSentinel: false,
    verifyLegacySnapshot: true,
  }
}

export function resolveBaselineTarget(
  entries: MigrationJournalEntry[],
  requestedThrough?: string,
): MigrationJournalEntry {
  const ordered = [...entries].sort((left, right) => left.when - right.when)
  if (ordered.length === 0) throw new Error("No migrations in journal; nothing to baseline.")

  const target = requestedThrough ?? LEGACY_BASELINE_THROUGH_TAG
  const entry = target === LATEST_BASELINE_ALIAS
    ? ordered[ordered.length - 1]
    : ordered.find((candidate) => candidate.tag === target)
  if (!entry) {
    throw new Error(`--through tag "${target}" not found in drizzle/meta/_journal.json`)
  }
  return entry
}
