const DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive"

export function canWriteDriveDocument(accountScopes: readonly string[] | null | undefined, enabledScopes: readonly string[]): boolean {
  return accountScopes?.some(grant => grant === DRIVE_WRITE_SCOPE) === true
    && enabledScopes.some(grant => grant === DRIVE_WRITE_SCOPE)
}
