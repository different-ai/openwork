// Advisory design notes inside the Evidence preview check: where agents (and
// people) read what the design review found, without the private review app.
// One publication, one check; the images stay in the report.
//
// Notes quote on-screen text, which a PR author controls, and model output.
// Nothing in them may become a link, an image, a mention or HTML here: every
// artifact-derived string is validated, capped, and rendered inert.

const MAX_NOTES = 60;
const MAX_TEXT = 60_000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value, limit) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
}

function strings(value, limit) {
  return Array.isArray(value) ? value.map(entry => text(entry, limit)).filter(Boolean).slice(0, 3) : [];
}

/** Accepts only the shape the trusted publisher writes; anything else is no digest. */
export function validateDesignDigest(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.reviewed) || value.reviewed < 0 || !Array.isArray(value.notes)) return undefined;
  const notes = [];
  for (const entry of value.notes.slice(0, MAX_NOTES)) {
    if (!isRecord(entry) || !["medium", "low"].includes(entry.severity) || !["layout", "vision"].includes(entry.source)) continue;
    const rule = text(entry.rule, 40);
    const title = text(entry.title, 200);
    if (!/^[A-Za-z0-9._-]+$/.test(rule) || !title) continue;
    const spec = typeof entry.spec === "string" && entry.spec.length <= 200 && /^evals\/specs\/[\w./-]+\.test\.ts$/.test(entry.spec) && !entry.spec.includes("..") ? entry.spec : null;
    notes.push({ rule, severity: entry.severity, source: entry.source, title, detail: text(entry.detail, 1000), step: text(entry.step, 300),
      spec, anchors: strings(entry.anchors, 200), classes: strings(entry.classes, 160) });
  }
  return { reviewed: value.reviewed, notes, truncated: value.notes.length > MAX_NOTES };
}

/** Plain text only: Markdown, HTML, autolinks and mentions are escaped. */
export function inert(value) {
  return value
    .replace(/[\\`*_{}[\]()#+!|<>~]/g, character => `\\${character}`)
    .replaceAll("@", "@\u200b")
    .replaceAll("://", ":\u200b//")
    .replace(/^([ \t]*)([-=]{3,})/gm, "$1\\$2");
}

/** Inside a code span: backticks cannot close it early. */
function code(value) {
  return `\`${value.replaceAll("`", "'")}\``;
}

function reproduce(spec) {
  const slug = spec?.split("/").pop()?.replace(/\.e2e\.test\.ts$/, "").replace(/\.test\.ts$/, "");
  return slug
    ? `pnpm evals:e2e ${slug} --local && pnpm --dir evals design:review -- --test-run latest --json`
    : "pnpm --dir evals design:review -- --test-run latest --json";
}

/**
 * One summary line for the evidence check, and (when there are notes) the
 * text body listing each note: what is wrong, where in the code, how to
 * reproduce it, and the same notes as JSON.
 */
export function renderDesignNotes(digest) {
  const count = digest.notes.length;
  const worthFixing = digest.notes.filter(note => note.severity === "medium").length;
  const line = count === 0
    ? "Design review (advisory): no notes."
    : `Design review (advisory): ${count} ${count === 1 ? "note" : "notes"}${worthFixing ? `, ${worthFixing} worth fixing` : ""}. Each is listed below with where to look in the code and how to reproduce it.`;
  if (count === 0) return { line };
  const blocks = digest.notes.map((note, index) => {
    const where = [...note.anchors.map(code), ...note.classes.map(value => `class ${code(value)}`)];
    return [
      `### ${index + 1}. ${inert(note.title)}`,
      `- ${note.severity === "medium" ? "**Worth fixing**" : "Minor"} · rule ${code(note.rule)} · ${note.source === "layout" ? "measured" : "judged"}`,
      `- Screenshot: ${inert(note.step)}${note.spec ? ` (${code(note.spec)})` : ""}`,
      ...(where.length ? [`- Where in the code: ${where.join(" · ")}`] : []),
      `- ${inert(note.detail)}`,
      `- Reproduce: ${code(reproduce(note.spec))}`,
    ].join("\n");
  });
  const json = JSON.stringify(digest.notes.map(note => ({ ...note, reproduce: reproduce(note.spec) })), null, 2).replaceAll("`", "'");
  let body = [
    "## Design notes (advisory)",
    "Fix the notes worth fixing, or say in the PR why the screen is right. They never change the evidence verdict.",
    ...blocks,
    ...(digest.truncated ? [`Only the first ${MAX_NOTES} notes are listed.`] : []),
    `<details><summary>Notes as JSON</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n\n</details>`,
  ].join("\n\n");
  if (body.length > MAX_TEXT) body = `${blocks.join("\n\n").slice(0, MAX_TEXT - 200)}\n\nList truncated; run the reproduce command for every note.`;
  return { line, text: body };
}
