export function signedInRoute(activeOrgId: string | null | undefined): "/session" | "/onboarding" {
  return activeOrgId?.trim() ? "/session" : "/onboarding";
}
