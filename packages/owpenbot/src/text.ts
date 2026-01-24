export function chunkText(input: string, limit: number): string[] {
  if (input.length <= limit) return [input];
  const chunks: string[] = [];
  let current = "";

  for (const line of input.split(/\n/)) {
    if ((current + line).length + 1 > limit) {
      if (current) chunks.push(current.trimEnd());
      current = "";
    }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) {
        const slice = line.slice(i, i + limit);
        if (slice.length) chunks.push(slice);
      }
      continue;
    }
    current += current ? `\n${line}` : line;
  }

  if (current.trim().length) chunks.push(current.trimEnd());
  return chunks.length ? chunks : [input];
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function formatInputSummary(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (!entries.length) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
  }
}
