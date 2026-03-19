const SKILL_KEYWORDS = /\b(Identity|Scope|Trigger|Parameters|Default behaviors|When|Why|What|How|Runs|sends|handle|qualify|route|Score|Escalate|Send)\b/g;
const SKILL_TYPES = /\b(Agent|Skill|MCP|Config|Remote|Trigger|OpenWork|OpenCode|Duration|Handlebars)\b/g;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(className: string, inner: string): string {
  return `<span class="${className}">${inner}</span>`;
}

function highlightJsonLine(raw: string): string {
  const tokens: string[] = [];
  let index = 0;

  while (index < raw.length) {
    if (raw[index] === '"') {
      const end = raw.indexOf('"', index + 1);
      if (end === -1) break;
      const chunk = raw.slice(index, end + 1);
      const trailing = raw.slice(end + 1).trimStart();

      if (trailing.startsWith(":")) {
        tokens.push(span("hl-key", escapeHtml(chunk)));
      } else if (/^https?:\/\//.test(chunk.slice(1, -1))) {
        tokens.push(span("hl-url", escapeHtml(chunk)));
      } else {
        tokens.push(span("hl-string", escapeHtml(chunk)));
      }

      index = end + 1;
      continue;
    }

    if (/[{}\[\]]/.test(raw[index])) {
      tokens.push(span("hl-bracket", escapeHtml(raw[index])));
      index += 1;
      continue;
    }

    if (raw[index] === ":" || raw[index] === ",") {
      tokens.push(span("hl-punctuation", escapeHtml(raw[index])));
      index += 1;
      continue;
    }

    if (/\d/.test(raw[index])) {
      const match = raw.slice(index).match(/^\d+(\.\d+)?/);
      if (match) {
        tokens.push(span("hl-number", match[0]));
        index += match[0].length;
        continue;
      }
    }

    if (raw.startsWith("true", index) && !/\w/.test(raw[index + 4] || "")) {
      tokens.push(span("hl-keyword", "true"));
      index += 4;
      continue;
    }

    if (raw.startsWith("false", index) && !/\w/.test(raw[index + 5] || "")) {
      tokens.push(span("hl-keyword", "false"));
      index += 5;
      continue;
    }

    if (raw.startsWith("null", index) && !/\w/.test(raw[index + 4] || "")) {
      tokens.push(span("hl-keyword", "null"));
      index += 4;
      continue;
    }

    if (raw.startsWith("//", index)) {
      tokens.push(span("hl-comment", escapeHtml(raw.slice(index))));
      break;
    }

    tokens.push(escapeHtml(raw[index]));
    index += 1;
  }

  return tokens.join("");
}

function highlightMarkdownLine(raw: string): string {
  const escaped = escapeHtml(raw);

  if (/^#{1,6}\s/.test(raw)) {
    const match = escaped.match(/^(#{1,6}\s)(.*)/);
    if (match) {
      return span("hl-punctuation", match[1]) + span("hl-heading", match[2]);
    }
  }

  let result = escaped;

  result = result.replace(/^(\s*)(- )([a-z_]+)(:\s)/g, (_, whitespace: string, bullet: string, field: string, separator: string) => {
    return whitespace + span("hl-punctuation", bullet) + span("hl-field", field) + span("hl-punctuation", separator);
  });
  result = result.replace(/^(\s*)(- )/g, (_, whitespace: string, bullet: string) => whitespace + span("hl-punctuation", bullet));
  result = result.replace(/(&quot;[^&]*(?:&[^&]*)*?&quot;)/g, span("hl-string", "$1"));
  result = result.replace(/(`[^`]+`)/g, span("hl-inline-code", "$1"));
  result = result.replace(/(\*\*[^*]+\*\*)/g, span("hl-bold", "$1"));
  result = result.replace(SKILL_KEYWORDS, span("hl-keyword", "$1"));
  result = result.replace(SKILL_TYPES, span("hl-type", "$1"));
  result = result.replace(/\b(\d+(?:\.\d+)?(?:h|ms|s|m)?)\b/g, span("hl-number", "$1"));
  result = result.replace(/(\|)/g, span("hl-punctuation", "$1"));

  return result;
}

export function highlightSyntax(text: string): string {
  if (!text) return "";

  const normalized = text.replace(/\r\n/g, "\n");
  const frontmatterMatch = normalized.match(/^(---\n[\s\S]*?\n---)(\n?)/);
  const body = frontmatterMatch ? normalized.slice(frontmatterMatch[0].length) : normalized;
  const trimmed = body.trimStart();
  const highlightLine = trimmed.startsWith("{") || trimmed.startsWith("[") ? highlightJsonLine : highlightMarkdownLine;
  const bodyHtml = body.split("\n").map(highlightLine).join("\n");

  if (!frontmatterMatch) return bodyHtml;

  const frontmatterHtml = frontmatterMatch[1]
    .split("\n")
    .map((line) => span("hl-frontmatter", escapeHtml(line)))
    .join("\n");

  return body ? `${frontmatterHtml}\n${bodyHtml}` : frontmatterHtml;
}
