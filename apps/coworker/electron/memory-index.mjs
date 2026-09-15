/**
 * The long-term memory index (`memory/index.md`) is Markdown the coworker
 * maintains: one bullet per durable memory file with a one-line summary. The
 * app reads it as structure rather than text, so these helpers parse the
 * bullets a model actually writes (backticked paths, plain paths, links, with
 * or without the `memory/` and `long-term/` prefixes) and edit the file
 * line by line, leaving the human-facing prose around the list untouched.
 *
 * No Electron imports here: exercised directly by `node --test`.
 */

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
/** A path-like token ending in `.md`; validated after the known prefixes are stripped. */
const FILE_REFERENCE = /[^\s`'"()[\]<>]+\.md(?![A-Za-z0-9])/;
const PLACEHOLDER = /^\s*\(none yet\)\s*$/;

/** A long-term memory file name is a bare `.md` file, never a path. */
export function isMemoryFileName(file) {
  return typeof file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) && !file.includes("..");
}

/** `./memory/long-term/people.md` → `people.md`; anything outside the long-term folder → null. */
function memoryFileFromReference(token) {
  const file = token.replace(/^\.\//, "").replace(/^memory\//, "").replace(/^long-term\//, "");
  return isMemoryFileName(file) ? file : null;
}

/**
 * Parse one bullet into `{ file, summary }`, or null when the bullet does not
 * reference a memory file.
 */
export function parseIndexLine(line) {
  const bullet = BULLET.exec(line);
  if (!bullet) return null;
  const body = bullet[1];
  const reference = FILE_REFERENCE.exec(body);
  if (!reference) return null;
  const file = memoryFileFromReference(reference[0]);
  if (!file) return null;
  const linked = body.replace(new RegExp(`\\[([^\\]]*)\\]\\(${escapeRegExp(reference[0])}\\)`), "$1");
  const withoutReference = linked === body
    ? body.replace(reference[0], "")
    : linked;
  const summary = withoutReference
    .replace(/`\s*`/g, "")
    .replace(/^[\s`'"()[\]:–—-]+/, "")
    .replace(/[\s`'"()[\]:–—-]+$/, "")
    .trim();
  return { file, summary };
}

/** Every memory entry in index order, with the line each came from. */
export function parseMemoryIndex(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const entries = [];
  lines.forEach((line, lineNumber) => {
    const entry = parseIndexLine(line);
    if (entry) entries.push({ ...entry, lineNumber });
  });
  return entries;
}

/** Remove every bullet that references `file`; add the placeholder back when the list empties. */
export function removeFromMemoryIndex(text, file) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kept = lines.filter((line) => parseIndexLine(line)?.file !== file);
  if (kept.length === lines.length) return String(text ?? "");
  if (!kept.some((line) => parseIndexLine(line)) && !kept.some((line) => PLACEHOLDER.test(line))) {
    const trailing = trailingBlankCount(kept);
    kept.splice(kept.length - trailing, 0, "(none yet)");
  }
  return kept.join("\n");
}

/** Append a bullet for `file` unless one exists; the placeholder gives way to the first entry. */
export function addToMemoryIndex(text, file, summary) {
  const source = String(text ?? "");
  const entries = parseMemoryIndex(source);
  if (entries.some((entry) => entry.file === file)) return source;
  const bullet = `- \`long-term/${file}\` — ${String(summary ?? "").trim() || humanizeMemoryFileName(file)}`;
  const lines = source.split(/\r?\n/);
  const placeholder = lines.findIndex((line) => PLACEHOLDER.test(line));
  if (placeholder >= 0) {
    lines[placeholder] = bullet;
    return lines.join("\n");
  }
  const last = entries.at(-1);
  if (last) {
    lines.splice(last.lineNumber + 1, 0, bullet);
    return lines.join("\n");
  }
  const trailing = trailingBlankCount(lines);
  const body = lines.slice(0, lines.length - trailing);
  if (body.length > 0 && body.at(-1).trim() !== "") body.push("");
  body.push(bullet);
  return `${body.join("\n")}\n`;
}

/** The first Markdown heading, or a readable form of the file name. */
export function memoryTitle(markdown, file) {
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) return heading[1].trim();
    if (line.trim() !== "") break;
  }
  return humanizeMemoryFileName(file);
}

/** `cleaning-day.md` → `Cleaning day`. */
export function humanizeMemoryFileName(file) {
  const stem = String(file ?? "").replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : "Memory";
}

/** `Street cleaning: move the car` → `street-cleaning-move-the-car.md`. */
export function memoryFileNameFor(title) {
  const stem = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${stem || "memory"}.md`;
}

function trailingBlankCount(lines) {
  let count = 0;
  for (let index = lines.length - 1; index >= 0 && lines[index].trim() === ""; index -= 1) count += 1;
  return count;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
