import { parse, stringify } from "yaml";

export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: {}, body: content };
  }
  const raw = match[1] ?? "";
  const data = (parse(raw) as Record<string, unknown>) ?? {};
  const body = content.slice(match[0].length);
  return { data, body };
}

export function buildFrontmatter(data: Record<string, unknown>): string {
  const yaml = stringify(data).trimEnd();
  return `---\n${yaml}\n---\n`;
}
