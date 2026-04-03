export type ParsedSkillMarkdown = {
  name: string
  description: string
  body: string
  hasFrontmatter: boolean
}

const SKILL_FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/

function normalizeSkillText(content: string): string {
  return String(content ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
}

function normalizeFrontmatterValue(value: string | undefined): string {
  const normalized = String(value ?? "").trim()
  if (!normalized) {
    return ""
  }

  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      const parsed = JSON.parse(normalized)
      return typeof parsed === "string" ? parsed.trim() : normalized
    } catch {
      return normalized.slice(1, -1).trim()
    }
  }

  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1).trim()
  }

  return normalized
}

function parseFrontmatter(header: string): Record<string, string> {
  const data: Record<string, string> = {}

  for (const line of header.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) {
      continue
    }

    const key = match[1]?.trim().toLowerCase()
    if (!key) {
      continue
    }

    data[key] = normalizeFrontmatterValue(match[2])
  }

  return data
}

export function yamlValue(value: string): string {
  const normalized = String(value ?? "").trim()
  if (/^[A-Za-z0-9._/\- ]+$/.test(normalized) && normalized && !normalized.includes(":")) {
    return normalized
  }
  return JSON.stringify(normalized)
}

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const text = normalizeSkillText(content)
  const match = text.match(SKILL_FRONTMATTER_PATTERN)
  if (!match) {
    return {
      name: "",
      description: "",
      body: text,
      hasFrontmatter: false,
    }
  }

  const header = match[1] ?? ""
  const data = parseFrontmatter(header)

  return {
    name: normalizeFrontmatterValue(data.name),
    description: normalizeFrontmatterValue(data.description),
    body: text.slice(match[0].length),
    hasFrontmatter: true,
  }
}

export function hasSkillFrontmatterName(content: string): boolean {
  const parsed = parseSkillMarkdown(content)
  return parsed.hasFrontmatter && Boolean(parsed.name.trim())
}

export function composeSkillMarkdown(name: string, description: string, body: string): string {
  const normalizedName = String(name ?? "").trim()
  const normalizedDescription = String(description ?? "").trim()
  const normalizedBody = normalizeSkillText(body).trim()
  const frontmatter = [
    "---",
    `name: ${yamlValue(normalizedName)}`,
    ...(normalizedDescription ? [`description: ${yamlValue(normalizedDescription)}`] : []),
    "---",
  ].join("\n")

  return normalizedBody ? `${frontmatter}\n\n${normalizedBody}\n` : `${frontmatter}\n`
}
