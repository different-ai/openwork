const DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive"

/** OAuth scope URLs are opaque grant identifiers, matched as complete values in both grant sets. */
export function canWriteDriveDocument(accountScopes: readonly string[] | null | undefined, enabledScopes: readonly string[]): boolean {
  return accountScopes?.some(grant => grant === DRIVE_WRITE_SCOPE) === true
    && enabledScopes.some(grant => grant === DRIVE_WRITE_SCOPE)
}
