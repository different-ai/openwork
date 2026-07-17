export const OPTIONAL_SCOPE_BULK_TOGGLE_THRESHOLD = 5;

export function areAllOptionalScopesSelected(
  requestedScopes: readonly string[],
  optionalScopes: readonly string[],
): boolean {
  return optionalScopes.length > 0
    && optionalScopes.every((scope) => requestedScopes.includes(scope));
}

export function toggleAllOptionalScopes(
  requestedScopes: readonly string[],
  optionalScopes: readonly string[],
): string[] {
  if (areAllOptionalScopesSelected(requestedScopes, optionalScopes)) {
    return requestedScopes.filter((scope) => !optionalScopes.includes(scope));
  }
  return [...new Set([...requestedScopes, ...optionalScopes])];
}
