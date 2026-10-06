// SEAM(W0-05): minimal local stand-in for the Core hook registry
// (`core/hooks/*`). It implements only the three points W0-P11 needs, with the
// registration shape and skip rule W0-05 specifies, so W0-05 can replace this
// file with `registerCoreHooks()` / `runParticipants()` / `collect()` without
// touching call sites. Whoever merges second deletes this file.
//
// Points:
// - `membership.mutation.participant` (participant)
// - `member.effectiveAuthority` (contributor)
// - `member.authorityExclusion` (contributor, security; new in the W0-05 catalogue)
//
// Pure TypeScript: no runtime imports, so the pipeline is unit-testable.
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { CoreReader, CoreTx } from "./types.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

export const CORE_HOOK_ORDER = { lock: 100, guard: 200, security: 300, cleanup: 400, default: 500, sync: 800 } as const

type CoreHookFlags = {
  id: string
  registrant: string
  moduleId?: string
  order?: number
  security?: boolean
  alwaysRun?: "cleanup" | "consistency"
}

export interface CoreHookModuleStateSource {
  isEffective(input: { organizationId: OrganizationId; moduleId: string; tx?: CoreTx }): Promise<boolean>
}

const allModulesOn: CoreHookModuleStateSource = { isEffective: async () => true }

// Skip rule from W0-05: Core-owned, security and always-run hooks always run;
// module hooks run only when their module is effective for the organization.
export async function shouldRunCoreHook(
  hook: CoreHookFlags,
  input: { organizationId: OrganizationId; tx?: CoreTx },
  source: CoreHookModuleStateSource,
) {
  if (hook.moduleId === undefined || hook.security === true || hook.alwaysRun !== undefined) return true
  return source.isEffective({ organizationId: input.organizationId, moduleId: hook.moduleId, tx: input.tx })
}

function byOrder<T extends CoreHookFlags>(hooks: readonly T[]) {
  return [...hooks].sort((left, right) =>
    (left.order ?? CORE_HOOK_ORDER.default) - (right.order ?? CORE_HOOK_ORDER.default) || left.id.localeCompare(right.id))
}

// membership.mutation.participant --------------------------------------------

export type MembershipMutationContext = {
  organizationId: OrganizationId
  memberIds: MemberId[]
  tx: CoreTx
}

export type MembershipMutationParticipant = CoreHookFlags & {
  // Wraps the mutation body. Lower order wraps outermost: its pre-step runs
  // first and its post-step runs last.
  run: <T>(context: MembershipMutationContext, next: () => Promise<T>) => Promise<T>
}

export async function runMembershipMutationParticipants<T>(
  participants: readonly MembershipMutationParticipant[],
  context: MembershipMutationContext,
  body: () => Promise<T>,
  source: CoreHookModuleStateSource = allModulesOn,
): Promise<T> {
  const active: MembershipMutationParticipant[] = []
  for (const participant of byOrder(participants)) {
    if (await shouldRunCoreHook(participant, context, source)) active.push(participant)
  }
  const step = (index: number): Promise<T> => {
    const participant = active[index]
    return participant ? participant.run(context, () => step(index + 1)) : body()
  }
  return step(0)
}

// member.effectiveAuthority + member.authorityExclusion ------------------------

export type AuthorityElevation = {
  role: "admin"
  source: { kind: string; id: string; name: string; teamMemberId?: string }
}

export type AuthorityCandidate = {
  memberId: MemberId
  userId: DenTypeId<"user"> | null
  elevation: AuthorityElevation
}

export type AuthorityQuery = {
  organizationId: OrganizationId
  // Undefined means every active member of the organization (batch form).
  memberId?: MemberId
  database: CoreReader
  // "share" rechecks authority under FOR SHARE inside a caller's transaction.
  lock?: "share"
}

export type AuthorityContributor = CoreHookFlags & {
  collect: (query: AuthorityQuery) => Promise<AuthorityCandidate[]>
}

export type AuthorityExclusion = CoreHookFlags & {
  // Exclusions only remove authority, so they must always run.
  security: true
  exclude: (query: AuthorityQuery, candidates: readonly AuthorityCandidate[]) => Promise<ReadonlySet<string>>
}

export function authorityCandidateKey(candidate: AuthorityCandidate) {
  const { kind, id, teamMemberId } = candidate.elevation.source
  return JSON.stringify([candidate.memberId, kind, id, teamMemberId ?? null])
}

export async function runAuthorityPipeline(
  hooks: { contributors: readonly AuthorityContributor[]; exclusions: readonly AuthorityExclusion[] },
  query: AuthorityQuery,
  source: CoreHookModuleStateSource = allModulesOn,
): Promise<Map<MemberId, AuthorityElevation[]>> {
  const candidates: AuthorityCandidate[] = []
  for (const contributor of byOrder(hooks.contributors)) {
    if (!(await shouldRunCoreHook(contributor, query, source))) continue
    candidates.push(...await contributor.collect(query))
  }
  let remaining = candidates
  for (const exclusion of byOrder(hooks.exclusions)) {
    if (remaining.length === 0) break
    const dropped = await exclusion.exclude(query, remaining)
    if (dropped.size > 0) remaining = remaining.filter((candidate) => !dropped.has(authorityCandidateKey(candidate)))
  }
  const byMember = new Map<MemberId, AuthorityElevation[]>()
  for (const candidate of remaining) {
    const elevations = byMember.get(candidate.memberId) ?? []
    elevations.push(candidate.elevation)
    byMember.set(candidate.memberId, elevations)
  }
  return byMember
}

// Registry --------------------------------------------------------------------

const registry = {
  frozen: false,
  participants: [] as MembershipMutationParticipant[],
  contributors: [] as AuthorityContributor[],
  exclusions: [] as AuthorityExclusion[],
  ids: new Set<string>(),
  moduleState: allModulesOn,
}

function claim(id: string) {
  if (registry.frozen) throw new Error(`Core hook ${id} registered after the registry was frozen.`)
  if (registry.ids.has(id)) throw new Error(`Core hook ${id} is registered twice.`)
  registry.ids.add(id)
}

export function registerMembershipMutationParticipant(participant: MembershipMutationParticipant) {
  claim(participant.id)
  registry.participants.push(participant)
}

export function registerAuthorityContributor(contributor: AuthorityContributor) {
  claim(contributor.id)
  registry.contributors.push(contributor)
}

export function registerAuthorityExclusion(exclusion: AuthorityExclusion) {
  claim(exclusion.id)
  registry.exclusions.push(exclusion)
}

export function setCoreHookModuleStateSource(source: CoreHookModuleStateSource) {
  registry.moduleState = source
}

export function freezeCoreHookSeams() {
  registry.frozen = true
}

// Membership locks and authority both depend on registrations. Running before
// they are installed would silently skip usage locks or SCIM exclusions, so
// fail closed instead.
function installedRegistry() {
  if (!registry.frozen) throw new Error("Core hooks are not installed; import core/legacy-hooks.js before membership mutations or authority checks.")
  return registry
}

export function registeredMembershipMutationParticipants() {
  return { participants: installedRegistry().participants, moduleState: registry.moduleState }
}

export function registeredAuthorityHooks() {
  const installed = installedRegistry()
  return { contributors: installed.contributors, exclusions: installed.exclusions, moduleState: installed.moduleState }
}

export function describeCoreHookSeams() {
  return {
    "membership.mutation.participant": byOrder(registry.participants).map((hook) => hook.id),
    "member.effectiveAuthority": byOrder(registry.contributors).map((hook) => hook.id),
    "member.authorityExclusion": byOrder(registry.exclusions).map((hook) => hook.id),
  }
}
