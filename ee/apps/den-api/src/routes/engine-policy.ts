/** Compatibility response for older desktops: OpenCode v2 migration is always enabled. */
export async function readOrganizationEnginePolicy(_organizationId: string, _ownerMemberId?: string) {
  return { upgrade: true }
}
