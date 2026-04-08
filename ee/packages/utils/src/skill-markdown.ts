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

function foldYamlBlockLines(lines: string[], mode: "literal" | "folded"): string {
  const normalized = lines.map((line) => line.replace(/[ \t]+$/g, ""))
  if (mode === "literal") {
    return normalized.join("\n").trim()
  }

  const folded: string[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return
    }
    folded.push(paragraph.join(" "))
    paragraph = []
  }

  for (const line of normalized) {
    if (!line.trim()) {
      flushParagraph()
      if (folded.length === 0 || folded[folded.length - 1] !== "") {
        folded.push("")
      }
      continue
    }
    paragraph.push(line.trim())
  }

  flushParagraph()
  return folded.join("\n").trim()
}

function parseFrontmatter(header: string): Record<string, string> {
  const data: Record<string, string> = {}
  const lines = header.split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) {
      continue
    }

    const key = match[1]?.trim().toLowerCase()
    if (!key) {
      continue
    }

    const rawValue = (match[2] ?? "").trimEnd()
    const blockScalarMatch = rawValue.match(/^([>|])[-+0-9]*$/)

    if (blockScalarMatch) {
      const mode = blockScalarMatch[1] === ">" ? "folded" : "literal"
      const blockLines: string[] = []
      let blockIndent: number | null = null
      let nextIndex = index + 1

      for (; nextIndex < lines.length; nextIndex += 1) {
        const nextLine = lines[nextIndex] ?? ""
        const nextTrimmed = nextLine.trim()
        if (!nextTrimmed) {
          blockLines.push("")
          continue
        }

        const indent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0
        if (blockIndent === null) {
          if (indent === 0) {
            break
          }
          blockIndent = indent
        }

        if (indent < blockIndent) {
          break
        }

        blockLines.push(nextLine.slice(blockIndent))
      }

      data[key] = foldYamlBlockLines(blockLines, mode)
      index = nextIndex - 1
      continue
    }

    data[key] = normalizeFrontmatterValue(rawValue)
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
