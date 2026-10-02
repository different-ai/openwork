export type MemberRoute = "/install" | "/setup";
export type SetupBootstrapStatus = "loading" | "available" | "complete" | "unavailable";
export type MemberAuthCheckStatus = "checking" | "ready" | "error";
export type MemberAuthGuardDecision = "render" | "wait" | "error" | "sso" | "sign-in";

const MEMBER_RETURN_TO_PATHS: ReadonlySet<string> = new Set<MemberRoute>(["/install", "/setup"]);

export function getSafeMemberReturnTo(value: string | null | undefined): MemberRoute | null {
  const candidate = value?.trim() ?? "";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return null;
  }

  try {
    const parsed = new URL(candidate, "https://openwork.invalid");
    if (parsed.origin !== "https://openwork.invalid" || parsed.search || parsed.hash || !MEMBER_RETURN_TO_PATHS.has(parsed.pathname)) {
      return null;
    }
    return parsed.pathname === "/install" ? "/install" : "/setup";
  } catch {
    return null;
  }
}

export function resolveMemberReturnTo(value: string | null | undefined, hasHigherPriorityHandoff: boolean): MemberRoute | null {
  return hasHigherPriorityHandoff ? null : getSafeMemberReturnTo(value);
}

export function resolveMemberAuthGuardDecision(input: {
  route: MemberRoute;
  hasInstallToken: boolean;
  setupStatus: SetupBootstrapStatus;
  authCheckStatus: MemberAuthCheckStatus;
  signedIn: boolean;
  singleOrgSsoConfigured: boolean;
  singleOrgSlug: string;
}): MemberAuthGuardDecision {
  if (input.route === "/install" && input.hasInstallToken) {
    return "render";
  }
  if (input.route === "/setup" && input.setupStatus !== "complete") {
    return "render";
  }
  if (input.authCheckStatus === "checking") {
    return "wait";
  }
  if (input.authCheckStatus === "error") {
    return "error";
  }
  if (input.signedIn) {
    return "render";
  }
  if (input.singleOrgSsoConfigured && input.singleOrgSlug.trim()) {
    return "sso";
  }
  return "sign-in";
}
