/**
 * Minimal deterministic frontmatter codec shared by the coworker record
 * (`coworker.md`) and coworker documents (`documents/<id>.md`). Open Coworker is
 * the only writer of these files, so the accepted grammar is intentionally
 * small: `key: value` lines where value is a JSON string, JSON array, JSON
 * number, or a bare string. Anything after the closing `---` is the body.
 *
 * No Electron imports here: exercised directly by `node --test`.
 */

export function parseFrontmatter(content) {
  const text = String(content ?? "");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const data = {};
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") || value.startsWith("\"") || /^-?\d+(\.\d+)?$/.test(value)) {
      try {
        data[key] = JSON.parse(value);
        continue;
      } catch {
        // Fall through to the bare-string reading.
      }
    }
    data[key] = value;
  }
  return { data, body };
}

export function serializeFrontmatter(data, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    if (typeof value === "number") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    const text = String(value);
    const needsQuoting = text.includes(":") || text.startsWith("[") || text.startsWith("\"")
      || text !== text.trim() || text.includes("\n") || /^-?\d+(\.\d+)?$/.test(text);
    lines.push(`${key}: ${needsQuoting ? JSON.stringify(text) : text}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${String(body ?? "")}`;
}
