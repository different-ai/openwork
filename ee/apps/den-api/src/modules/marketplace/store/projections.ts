import { parseSkillMarkdown } from "@openwork-ee/utils"
import { clampCodePoints, clampUtf8Bytes, PROJECTION_TEXT_MAX_BYTES, PROJECTION_TITLE_MAX_CHARS } from "../../../routes/org/plugin-system/projection-text.js"
import { PluginArchRouteFailure } from "./route-failure.js"
import { deriveAuthoredMcpAppProjection } from "./object-types/app.js"
import {
  type ConfigObjectInput,
  type ConfigObjectRow,
  firstTextLine,
  normalizeOptionalString,
  stripLineDecorators,
} from "./internal.js"

const STANDARD_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function deriveSkillProjection(value: ConfigObjectInput) {
  const rawSourceText = normalizeOptionalString(value.rawSourceText)
  if (!rawSourceText) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_source",
      "Skill components require rawSourceText containing the complete SKILL.md.",
    )
  }

  const parsed = parseSkillMarkdown(rawSourceText)
  if (!parsed.hasFrontmatter) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_frontmatter",
      "SKILL.md must start with YAML frontmatter delimited by --- lines.",
    )
  }

  const name = parsed.name.trim()
  if (!name) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_name",
      "SKILL.md frontmatter requires a non-empty name.",
    )
  }
  if (name.length > 64 || !STANDARD_SKILL_NAME_PATTERN.test(name)) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_name",
      "SKILL.md frontmatter name must be 1-64 characters, contain only lowercase letters, numbers, and hyphens, and cannot start, end, or use consecutive hyphens.",
    )
  }

  const description = parsed.description.trim()
  if (!description) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_description",
      "SKILL.md frontmatter requires a non-empty description.",
    )
  }
  if (description.length > 1_024) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_description",
      "SKILL.md frontmatter description must be 1024 characters or fewer.",
    )
  }

  const body = parsed.body.trim()
  if (!body) {
    throw new PluginArchRouteFailure(
      400,
      "invalid_skill_body",
      "SKILL.md requires a non-empty Markdown instruction body after the frontmatter.",
    )
  }

  return {
    description,
    searchText: clampUtf8Bytes([name, description, body].join("\n"), PROJECTION_TEXT_MAX_BYTES),
    title: name,
  }
}

export function deriveProjection(input: { objectType: ConfigObjectRow["objectType"]; value: ConfigObjectInput }) {
  const appProjection = deriveAuthoredMcpAppProjection(input)
  if (appProjection) {
    return appProjection
  }
  if (input.objectType === "skill") {
    return deriveSkillProjection(input.value)
  }

  const metadata = input.value.metadata ?? {}
  const payload = input.value.normalizedPayloadJson ?? {}
  const rawSourceText = normalizeOptionalString(input.value.rawSourceText)
  const titleCandidate = [
    typeof metadata.title === "string" ? metadata.title : null,
    typeof metadata.name === "string" ? metadata.name : null,
    typeof payload.title === "string" ? payload.title : null,
    typeof payload.name === "string" ? payload.name : null,
    rawSourceText ? stripLineDecorators(firstTextLine(rawSourceText)) : null,
  ].find((value) => Boolean(normalizeOptionalString(value ?? undefined)))

  const descriptionCandidate = [
    typeof metadata.description === "string" ? metadata.description : null,
    typeof payload.description === "string" ? payload.description : null,
    rawSourceText
      ? rawSourceText
        .split(/\r?\n/g)
        .map((line) => stripLineDecorators(line.trim()))
        .filter(Boolean)
        .slice(1)
        .find(Boolean) ?? null
      : null,
  ].find((value) => Boolean(normalizeOptionalString(value ?? undefined)))

  const title = clampCodePoints(
    normalizeOptionalString(titleCandidate ?? undefined)
      ?? `${input.objectType.charAt(0).toUpperCase()}${input.objectType.slice(1)} ${new Date().toISOString()}`,
    PROJECTION_TITLE_MAX_CHARS,
  )

  const description = normalizeOptionalString(descriptionCandidate ?? undefined)
  const searchText = [title, description, rawSourceText].filter(Boolean).join("\n")

  return {
    description: description ? clampUtf8Bytes(description, PROJECTION_TEXT_MAX_BYTES) : null,
    searchText: searchText ? clampUtf8Bytes(searchText, PROJECTION_TEXT_MAX_BYTES) : null,
    title,
  }
}
