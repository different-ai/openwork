export const OPTIONAL_SCOPE_BULK_TOGGLE_THRESHOLD = 5;

export type OptionalScopeSelectionState = "none" | "some" | "all";

export function getOptionalScopeSelectionState(
  requestedScopes: readonly string[],
  optionalScopes: readonly string[],
): OptionalScopeSelectionState {
  const selectedCount = optionalScopes.filter((scope) => requestedScopes.includes(scope)).length;
  if (selectedCount === 0) return "none";
  return selectedCount === optionalScopes.length ? "all" : "some";
}

export function toggleAllOptionalScopes(
  requestedScopes: readonly string[],
  optionalScopes: readonly string[],
): string[] {
  if (getOptionalScopeSelectionState(requestedScopes, optionalScopes) === "all") {
    return requestedScopes.filter((scope) => !optionalScopes.includes(scope));
  }
  return [...new Set([...requestedScopes, ...optionalScopes])];
}
