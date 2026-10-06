type RevocationLogger = {
  info: (message: string, fields?: Readonly<Record<string, unknown>>) => void
  warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void
}

// Shared by the org-delete Google revocation hooks (aiGateway and
// connect.nativeProviders). A row that cannot be read (for example an
// undecryptable secret) must not block deletion.
export async function collectGrantsForRevocation<T>(
  logger: RevocationLogger,
  source: string,
  organizationId: string,
  collect: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await collect()
  } catch (error) {
    logger.warn("failed to collect google grants to revoke", { error, organization_id: organizationId, source })
    return []
  }
}

// Best effort and post-commit: deletion has already succeeded, and each
// revoke helper is bounded by its own 5 s budget.
export async function revokeAfterOrganizationDeletion(
  logger: RevocationLogger,
  input: { organizationId: string; source: string; count: number; revoke: () => Promise<void> },
) {
  logger.info("revoking google grants for deleted organization", {
    organization_id: input.organizationId,
    source: input.source,
    grant_count: input.count,
  })
  try {
    await input.revoke()
  } catch (error) {
    logger.warn("google grant revocation failed for deleted organization", { error, organization_id: input.organizationId, source: input.source })
  }
}
