import Anthropic from "@anthropic-ai/sdk"
import { SKILL_ZIP_MAX_BYTES } from "./skill-zip.js"

/**
 * Reads a team's custom Agent Skills from Anthropic's Skills API, so they can
 * move to OpenWork in one step. The person's Anthropic API key is used for the
 * request it arrives with and is never stored or logged; it reaches only
 * api.anthropic.com. A skill version downloads as a ZIP whose top folder is
 * the skill's name, which skill-zip.ts reads.
 */

/** Skills one listing or import handles. */
export const ANTHROPIC_SKILLS_MAX = 100

export type AnthropicSkillSummary = {
  id: string
  displayName: string
  latestVersionId: string
  updatedAt: string
}

export class AnthropicSkillsError extends Error {
  constructor(readonly status: 400 | 502, readonly code: string, message: string) {
    super(message)
  }
}

function client(apiKey: string) {
  // Always Anthropic's own API: never a base URL from the environment.
  return new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 2, timeout: 60_000 })
}

/** A sentence a person can act on for an error from Anthropic's API. */
export function anthropicSkillsFailure(error: unknown): AnthropicSkillsError {
  if (error instanceof AnthropicSkillsError) return error
  if (error instanceof Anthropic.AuthenticationError) return new AnthropicSkillsError(400, "anthropic_key_rejected", "Anthropic did not accept that API key. Check it in the Claude Console and try again.")
  if (error instanceof Anthropic.PermissionDeniedError) return new AnthropicSkillsError(400, "anthropic_key_forbidden", "That API key cannot read skills. Use a key from the workspace that holds them.")
  if (error instanceof Anthropic.NotFoundError) return new AnthropicSkillsError(400, "anthropic_skill_not_found", "Anthropic could not find that skill in this API key's workspace.")
  if (error instanceof Anthropic.RateLimitError) return new AnthropicSkillsError(502, "anthropic_rate_limited", "Anthropic is limiting requests right now. Wait a minute and try again.")
  if (error instanceof Anthropic.APIConnectionError) return new AnthropicSkillsError(502, "anthropic_unreachable", "OpenWork could not reach Anthropic. Try again.")
  if (error instanceof Anthropic.APIError) return new AnthropicSkillsError(502, "anthropic_error", `Anthropic answered with an error${error.status ? ` (${error.status})` : ""}. Try again.`)
  throw error
}

/** The workspace's custom skills (not Anthropic's built-in ones), at most ANTHROPIC_SKILLS_MAX. */
export async function listAnthropicCustomSkills(apiKey: string): Promise<{ skills: AnthropicSkillSummary[]; truncated: boolean }> {
  const skills: AnthropicSkillSummary[] = []
  try {
    for await (const skill of client(apiKey).skills.list({ source: "custom" })) {
      if (skills.length === ANTHROPIC_SKILLS_MAX) return { skills, truncated: true }
      skills.push({ id: skill.id, displayName: skill.display_name, latestVersionId: skill.latest_version_id, updatedAt: skill.updated_at })
    }
  } catch (error) {
    throw anthropicSkillsFailure(error)
  }
  return { skills, truncated: false }
}

/** One skill's latest version as a ZIP archive, refused past the archive limit. */
export async function downloadAnthropicSkill(apiKey: string, skillId: string): Promise<{ displayName: string; zip: Buffer }> {
  try {
    const anthropic = client(apiKey)
    const skill = await anthropic.skills.retrieve(skillId)
    const response = await anthropic.beta.skills.versions.download(skill.latest_version_id, { skill_id: skill.id })
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > SKILL_ZIP_MAX_BYTES) throw tooLarge(skill.display_name)
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body?.getReader()
    if (!reader) throw new AnthropicSkillsError(502, "anthropic_error", "Anthropic sent an empty archive. Try again.")
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > SKILL_ZIP_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge(skill.display_name)
      }
      chunks.push(value)
    }
    return { displayName: skill.display_name, zip: Buffer.concat(chunks) }
  } catch (error) {
    throw anthropicSkillsFailure(error)
  }
}

function tooLarge(name: string) {
  return new AnthropicSkillsError(400, "anthropic_skill_too_large", `${name} is larger than ${SKILL_ZIP_MAX_BYTES / (1024 * 1024)} MB, the most a skill archive can be.`)
}
