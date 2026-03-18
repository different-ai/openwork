"use client";

export const DEFAULT_SKILL_NAME = "skill.md";
export const DEFAULT_SKILL_DESCRIPTION = "This is a skill I'm currently using.";

const SKILL_NAME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "identity",
  "into",
  "my",
  "of",
  "or",
  "parameters",
  "scope",
  "skill",
  "skills",
  "that",
  "the",
  "this",
  "to",
  "trigger",
  "when",
  "with",
  "your",
]);

export function yamlValue(value: string): string {
  const normalized = String(value ?? "").trim();
  if (/^[A-Za-z0-9._/\- ]+$/.test(normalized) && !normalized.includes(":")) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

function normalizeNameTokens(value: string): string[] {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token && token.length > 2 && !SKILL_NAME_STOPWORDS.has(token));
}

export function inferSkillNameFromBody(body: string): string {
  const candidateLines = [
    ...Array.from(String(body ?? "").matchAll(/^#{1,6}\s+(.+)$/gm)).map((match) => match[1] ?? ""),
    ...String(body ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12),
  ];

  for (const line of candidateLines) {
    const tokens = normalizeNameTokens(line);
    if (tokens.length >= 2) {
      return `${tokens[0]}-${tokens[1]}`;
    }
    if (tokens.length === 1) {
      return tokens[0];
    }
  }

  return "shared-skill";
}

export function resolveSkillName(name: string, body: string): string {
  const normalized = String(name ?? "").trim();
  if (normalized) return normalized;
  return inferSkillNameFromBody(body);
}

export function composeSkillMarkdown(name: string, description: string, body: string): string {
  const normalizedName = resolveSkillName(name, body);
  const normalizedDescription = String(description ?? "").trim() || DEFAULT_SKILL_DESCRIPTION;
  const normalizedBody = String(body ?? "").replace(/\r\n/g, "\n").trim();
  const frontmatter = [
    "---",
    `name: ${yamlValue(normalizedName)}`,
    `description: ${yamlValue(normalizedDescription)}`,
    "---",
  ].join("\n");

  return normalizedBody ? `${frontmatter}\n\n${normalizedBody}\n` : `${frontmatter}\n`;
}

export function normalizeSkillMarkdown(
  content: string,
  fallbackName = DEFAULT_SKILL_NAME,
  fallbackDescription = DEFAULT_SKILL_DESCRIPTION,
): string {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  const parsed = parseSkillMarkdown(text);
  if (parsed.hasFrontmatter) return text;
  return composeSkillMarkdown(fallbackName, fallbackDescription, text);
}

export function parseSkillMarkdown(content: string): { name: string; description: string; body: string; hasFrontmatter: boolean } {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {
      name: "",
      description: "",
      body: text,
      hasFrontmatter: false,
    };
  }

  const header = match[1] ?? "";
  const body = text.slice(match[0].length);
  const nameMatch = header.match(/^name:\s*(.+)$/m);
  const descriptionMatch = header.match(/^description:\s*(.+)$/m);

  const normalizeField = (value: string | undefined): string =>
    String(value ?? "")
      .trim()
      .replace(/^['"]|['"]$/g, "");

  return {
    name: normalizeField(nameMatch?.[1]),
    description: normalizeField(descriptionMatch?.[1]),
    body,
    hasFrontmatter: true,
  };
}
