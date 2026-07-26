type FrontmatterTrigger = {
  found: boolean;
  value: string | undefined;
};

function splitSkillFrontmatter(content: string): { frontmatter: string | undefined; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: undefined, body: content };
  }

  return {
    frontmatter: match[1] ?? "",
    body: content.slice(match[0].length),
  };
}

function readScalarFrontmatterValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("|") || trimmed.startsWith(">")) return undefined;

  const quote = trimmed[0];
  if (quote === "'" || quote === "\"") {
    return trimmed.length > 1 && trimmed.endsWith(quote)
      ? trimmed.slice(1, -1).trim() || undefined
      : undefined;
  }

  return trimmed;
}

function readFrontmatterTrigger(frontmatter: string): FrontmatterTrigger {
  let triggerFound = false;
  let triggerValue: string | undefined;
  let whenFound = false;
  let whenValue: string | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    if (line !== line.trimStart()) continue;

    const match = /^(trigger|when)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const value = readScalarFrontmatterValue(match[2] ?? "");
    if (match[1] === "trigger") {
      triggerFound = true;
      triggerValue = value;
    } else {
      whenFound = true;
      whenValue = value;
    }
  }

  if (triggerFound) return { found: true, value: triggerValue };
  if (whenFound) return { found: true, value: whenValue };
  return { found: false, value: undefined };
}

function extractTriggerFromWhenSection(body: string) {
  const lines = body.split(/\r?\n/);
  let inWhenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "").trim();
      inWhenSection = /^when to use$/i.test(heading);
      continue;
    }

    if (!inWhenSection) continue;

    const cleaned = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (cleaned) return cleaned;
  }

  return "";
}

// Keep this paired with apps/server/src/skills.ts for local skill inventory.
export function extractSkillTrigger(data: Record<string, unknown>, body: string): string | undefined {
  const trigger = typeof data.trigger === "string"
    ? data.trigger
    : typeof data.when === "string"
      ? data.when
      : extractTriggerFromWhenSection(body);
  const trimmed = trigger.trim();
  return trimmed ? trimmed : undefined;
}

export function extractSkillTriggerFromMarkdown(content: string): string | undefined {
  const { frontmatter, body } = splitSkillFrontmatter(content);
  if (frontmatter !== undefined) {
    const trigger = readFrontmatterTrigger(frontmatter);
    if (trigger.found) return trigger.value;
  }
  return extractSkillTrigger({}, body);
}
