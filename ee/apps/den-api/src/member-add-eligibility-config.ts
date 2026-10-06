// Every path that adds a member to an organization, as named by
// DEN_MEMBER_ADD_ELIGIBILITY_ENFORCE_PATHS. Pure, so env.ts and unit tests can
// load it without the database.
export const MEMBER_ADD_PATHS = [
  "invitation",
  "acceptance",
  "bootstrap",
  "sso_jit",
  "scim",
  "better_auth_invitation",
  "better_auth_other",
] as const

export type MemberAddPath = typeof MEMBER_ADD_PATHS[number]

export type MemberAddEligibilityConfig = {
  mode: "observe" | "enforce"
  enforcePaths: readonly MemberAddPath[]
}

function isMemberAddPath(value: string): value is MemberAddPath {
  return MEMBER_ADD_PATHS.some((path) => path === value)
}

export function parseMemberAddEligibilityConfig(input: { mode: "observe" | "enforce"; enforcePaths: string | undefined }): MemberAddEligibilityConfig {
  const enforcePaths: MemberAddPath[] = []
  for (const raw of (input.enforcePaths ?? "invitation").split(",")) {
    const path = raw.trim()
    if (!path) continue
    if (!isMemberAddPath(path)) {
      throw new Error(`DEN_MEMBER_ADD_ELIGIBILITY_ENFORCE_PATHS: unknown path "${path}" (expected ${MEMBER_ADD_PATHS.join(", ")})`)
    }
    enforcePaths.push(path)
  }
  return { mode: input.mode, enforcePaths }
}

// Den invitation create was the only seat-checked path before this flag
// family and stays enforced. Every other path enforces only in "enforce" mode
// and when listed.
export function isMemberAddEligibilityEnforced(path: MemberAddPath, config: MemberAddEligibilityConfig) {
  return path === "invitation" || (config.mode === "enforce" && config.enforcePaths.includes(path))
}
