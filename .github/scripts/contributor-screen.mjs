#!/usr/bin/env node
// Contributor screen: the first layer of checks on every push to a fork PR,
// before any of its code runs anywhere.
//
//   scan       deterministic checks over the PR's changes, read from git
//              objects: hidden or malformed characters, dependency and
//              install-script changes, database changes, binaries, code that
//              looks encoded, and text aimed at an AI reviewer. Free: no
//              model, no secrets. Runs on every push.
//   report     sets `contributor-pr/screen` from the scan and updates one
//              PR comment.
//   ai-screen  reads Warden's contributor-screen run (after a maintainer's
//              /test), sets `contributor-pr/ai-screen`, updates one comment.
//   review     reads a standard Warden run (diff-security-review and
//              confidentiality-review), sets `contributor-pr/warden` and
//              updates one PR comment.
//
// Runs only from the default branch. Never install, build, or run PR code.
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const SCREEN_CONTEXT = "contributor-pr/screen";
export const AI_SCREEN_CONTEXT = "contributor-pr/ai-screen";
export const WARDEN_CONTEXT = "contributor-pr/warden";
const SCREEN_MARKER = "<!-- contributor-pr:screen -->";
const AI_SCREEN_MARKER = "<!-- contributor-pr:ai-screen -->";
const WARDEN_MARKER = "<!-- contributor-pr:warden -->";

// --- Hidden and malformed characters ----------------------------------------

const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad, "SOFT HYPHEN"],
  [0x034f, 0x034f, "COMBINING GRAPHEME JOINER"],
  [0x061c, 0x061c, "ARABIC LETTER MARK"],
  [0x115f, 0x1160, "HANGUL FILLER"],
  [0x17b4, 0x17b5, "KHMER INVISIBLE VOWEL"],
  [0x180e, 0x180e, "MONGOLIAN VOWEL SEPARATOR"],
  [0x200b, 0x200d, "ZERO WIDTH CHARACTER"],
  [0x200e, 0x200f, "DIRECTION MARK"],
  [0x202a, 0x202e, "BIDIRECTIONAL OVERRIDE"],
  [0x2060, 0x2064, "INVISIBLE OPERATOR"],
  [0x2066, 0x2069, "BIDIRECTIONAL ISOLATE"],
  [0x206a, 0x206f, "DEPRECATED FORMAT CHARACTER"],
  [0x3164, 0x3164, "HANGUL FILLER"],
  [0xfe00, 0xfe0e, "VARIATION SELECTOR"],
  [0xfeff, 0xfeff, "ZERO WIDTH NO-BREAK SPACE"],
  [0xffa0, 0xffa0, "HALFWIDTH HANGUL FILLER"],
  [0xfff9, 0xfffb, "INTERLINEAR ANNOTATION"],
  [0xfffd, 0xfffd, "REPLACEMENT CHARACTER"],
  [0xe0000, 0xe007f, "TAG CHARACTER"],
  [0xe0100, 0xe01ef, "VARIATION SELECTOR SUPPLEMENT"],
];
const EMOJI_BASE = /[\p{Extended_Pictographic}\p{Regional_Indicator}0-9#*\u20e3]/u;
const CONFUSABLE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\uff21-\uff3a\uff41-\uff5a]/u;
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

function invisibleName(cp) {
  for (const [from, to, name] of INVISIBLE_RANGES) if (cp >= from && cp <= to) return name;
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d && cp !== 0x0c) return "CONTROL CHARACTER";
  if (cp >= 0x7f && cp <= 0x9f) return "CONTROL CHARACTER";
  if ((cp & 0xfffe) === 0xfffe || (cp >= 0xfdd0 && cp <= 0xfdef)) return "NONCHARACTER";
  return null;
}

// Characters are reported by code point only; the raw text is never echoed.
export function hiddenCharacters(line, { firstLine = false } = {}) {
  const found = [];
  const chars = [...line];
  chars.forEach((char, index) => {
    const cp = char.codePointAt(0);
    if (cp === 0xfeff && firstLine && index === 0) return;
    if (cp === 0xfe0f) {
      if (index > 0 && EMOJI_BASE.test(chars[index - 1])) return;
      found.push({ column: index + 1, codePoint: hex(cp), name: "VARIATION SELECTOR" });
      return;
    }
    const name = invisibleName(cp);
    if (name) found.push({ column: index + 1, codePoint: hex(cp), name });
  });
  // Escape sequences in strings (\n, \t, \u0041...) would glue a Latin
  // letter onto the next word, so "\nЛюди" looked like a mixed identifier.
  // Blank them out first, keeping columns where they were.
  const words = line.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrtbfv0'"`\\])/g, (escape) => " ".repeat(escape.length));
  for (const match of words.matchAll(/[\p{L}\p{M}\p{N}_$]+/gu)) {
    const token = match[0];
    if (/[A-Za-z]/.test(token) && CONFUSABLE_SCRIPTS.test(token)) {
      found.push({ column: [...words.slice(0, match.index)].length + 1, codePoint: "mixed", name: "MIXED-SCRIPT IDENTIFIER (look-alike letters)" });
    }
  }
  return found;
}

export function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

// --- Dependencies ---------------------------------------------------------------

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"];
const OVERRIDE_FIELDS = [["overrides"], ["resolutions"], ["pnpm", "overrides"], ["pnpm", "patchedDependencies"], ["pnpm", "onlyBuiltDependencies"]];
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare", "prepack", "postpack"];
const DEPENDENCY_MANIFESTS = /(^|\/)(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.c?js|yarn\.lock|package-lock\.json|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Gemfile(\.lock)?)$|^patches\//;

const pick = (object, path) => path.reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), object);
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// Anything that is not a plain registry version range pulls code from
// somewhere else: git, a URL, a tarball, a local path or an alias.
export function nonRegistrySpec(spec) {
  if (typeof spec !== "string") return true;
  if (/^(workspace|catalog):/.test(spec)) return false;
  return /^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|npm:|portal:|patch:)|\.(tgz|tar\.gz)$|^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec);
}

export function packageJsonChanges(path, before, after) {
  const items = [];
  for (const field of DEPENDENCY_FIELDS) {
    const old = asObject(before?.[field]);
    const next = asObject(after?.[field]);
    for (const [name, spec] of Object.entries(next)) {
      if (!(name in old)) items.push({ path, kind: "added", text: `adds ${field} \`${name}\` \`${spec}\`${nonRegistrySpec(spec) ? " (not from the npm registry)" : ""}` });
      else if (old[name] !== spec) items.push({ path, kind: "changed", text: `changes ${field} \`${name}\` from \`${old[name]}\` to \`${spec}\`${nonRegistrySpec(spec) ? " (not from the npm registry)" : ""}` });
    }
  }
  for (const field of OVERRIDE_FIELDS) {
    if (JSON.stringify(pick(before, field) ?? null) !== JSON.stringify(pick(after, field) ?? null)) {
      items.push({ path, kind: "override", text: `changes \`${field.join(".")}\`` });
    }
  }
  const oldScripts = asObject(before?.scripts);
  const newScripts = asObject(after?.scripts);
  for (const name of LIFECYCLE_SCRIPTS) {
    if (newScripts[name] !== undefined && newScripts[name] !== oldScripts[name]) {
      items.push({ path, kind: "install-script", text: `${name in oldScripts ? "changes" : "adds"} the \`${name}\` script, which runs on install` });
    }
  }
  return items;
}

// --- Paths that need a human ----------------------------------------------------

const DATABASE = /^ee\/packages\/den-db\/|\.sql$|^packaging\/helm\/[^/]+\/templates\/migration[^/]*\.ya?ml$|(^|\/)drizzle\.config\.[cm]?[jt]s$/;
const IMAGE = /\.(png|jpe?g|gif|webp|ico|icns|bmp|avif)$/i;
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|^packages\/sdk\/src\/gen\/|^packages\/docs\/openapi\.json$|\/drizzle\/meta\/|\.snap$|\.min\.[cm]?js$|\.svg$|\.map$/;
const CODE = /\.(m?[jt]sx?|c[jt]s|sh|bash|zsh|ps1|py|rb|rs|go|ya?ml|toml|html?|vue|svelte)$/i;

export function isDatabasePath(path) {
  return DATABASE.test(path);
}

// Heuristics only; the contributor-screen Warden skill judges intent.
export function encodedPayload(line) {
  if (/[A-Za-z0-9+/]{300,}={0,2}/.test(line)) return "a long base64-like string";
  if (/(?:[0-9a-fA-F]{2}){150,}/.test(line)) return "a long hex string";
  if ((line.match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}/g) ?? []).length >= 20) return "many escaped characters";
  if (/\b(String\.fromCharCode|fromCodePoint)\s*\(\s*(\d+\s*,\s*){8,}/.test(line)) return "a string built from character codes";
  if (/\beval\s*\(|\bnew\s+Function\s*\(|\batob\s*\([^)]*\)\s*\)|Buffer\.from\([^)]*,\s*['"](base64|hex)['"]\)[^;]*\b(eval|Function|require|import)\b/.test(line)) return "dynamic code execution";
  if (line.length > 1000) return "a very long line";
  return null;
}

// --- Text aimed at the AI reviewer -------------------------------------------------

// Warden's model reads the diff and the head commit message. No prompt makes
// a model immune to instructions hidden there, so this check does not use
// one: text that tries to talk to an AI reviewer holds the PR for a person.
// On the codebase as of this change, these match nothing outside CI and
// Warden configuration, which forks cannot change through this path.
const INJECTION = [
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,30}\b(all|any|the|your|previous|prior|above|earlier|preceding|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines|directives|context)\b/i, "tells the reader to ignore its instructions"],
  [/<\/?\s*(skill_instructions|scope_reminder|evidence|role|task|system|assistant|developer|instructions)\s*>/i, "imitates a prompt section tag"],
  [/["']?findings["']?\s*:\s*\[\s*\]/i, "contains an empty findings result"],
  [/\b(warden|security[\s-]review(er)?|code[\s-]review(er)?|ai[\s-]review(er)?|llm|language model|the reviewer|reviewing (ai|agent|model))\b[^\n]{0,80}\b(ignore|skip|don'?t (report|flag)|do not (report|flag)|no need to|report nothing|return no|mark (this|it) (as )?(safe|clean)|is safe|approve)\b/i, "addresses the AI reviewer"],
  [/\b(report|return|output)\s+(no|zero|an empty (list of )?)\s*findings\b/i, "asks for no findings"],
  [/\b(new|updated|real|actual)\s+(system\s+)?instructions\s*:/i, "announces new instructions"],
];

export function reviewerInstruction(line) {
  for (const [pattern, reason] of INJECTION) if (pattern.test(line)) return reason;
  return null;
}

// Splitting a phrase across lines, comments or string pieces is the obvious
// way around a per-line check, so lines are also joined after removing
// comment markers and string concatenation. This raises the bar; it cannot
// catch every rewording, which is why held PRs still need a person.
export function normalizeForInstructions(line) {
  return line
    .replace(/["'`]\s*\+\s*["'`]/g, "")
    .replace(/^\s*(\/\/+|\/\*+|\*+\/?|#+|<!--|--!?>|--|;+|"{3}|'{3}|>)\s?/, "")
    .replace(/\s*(\*\/|--!?>)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const INSTRUCTION_WINDOW = 4;

// `lines` is a list of { number, text } in order. Consecutive numbers form a
// run; every window of up to INSTRUCTION_WINDOW lines in a run is checked.
export function instructionHits(lines) {
  const hits = [];
  const reported = new Set();
  const matchOf = (from, to) => {
    if (from === to) return reviewerInstruction(lines[from].text) ?? reviewerInstruction(normalizeForInstructions(lines[from].text));
    return reviewerInstruction(lines.slice(from, to + 1).map((line) => normalizeForInstructions(line.text)).join(" ").trim());
  };
  lines.forEach((_, index) => {
    if (reported.has(lines[index].number)) return;
    for (let end = index; end < index + INSTRUCTION_WINDOW && end < lines.length; end += 1) {
      if (end > index && lines[end].number !== lines[end - 1].number + 1) break;
      if (!matchOf(index, end)) continue;
      // Narrow to the smallest run of lines that still matches.
      let start = index;
      while (start < end && matchOf(start + 1, end)) start += 1;
      if (reported.has(lines[start].number)) return;
      const reason = matchOf(start, end);
      hits.push({ line: lines[start].number, ...(end !== start ? { endLine: lines[end].number } : {}), reason });
      for (let covered = start; covered <= end; covered += 1) reported.add(lines[covered].number);
      return;
    }
  });
  return hits;
}

// --- Scan -----------------------------------------------------------------------

function parseNameStatus(text) {
  const files = [];
  const parts = text.split("\0").filter((part) => part !== "");
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (status.startsWith("R") || status.startsWith("C")) files.push({ status: status[0], previous: parts[index++], path: parts[index++] });
    else files.push({ status: status[0], path: parts[index++] });
  }
  return files;
}

function addedLineNumbers(patch) {
  const lines = new Set();
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return lines;
}

export function scanRepository({ gitDir, base, head }) {
  const git = (...args) => execFileSync("git", ["--git-dir", gitDir, ...args], { maxBuffer: 512 * 1024 * 1024 });
  const show = (sha, path) => {
    try {
      return git("show", `${sha}:${path}`);
    } catch {
      return null;
    }
  };
  const files = parseNameStatus(git("diff", "--name-status", "-z", "-M", base, head).toString());
  const binary = new Set(
    git("diff", "--numstat", "-z", "-M", base, head).toString().split("\0")
      .filter((entry) => entry.startsWith("-\t-\t")).map((entry) => entry.slice(4)).filter(Boolean),
  );
  const result = { files: files.map((file) => file.path), hidden: [], malformed: [], dependencies: [], database: [], binaries: [], images: [], encoded: [], injection: [] };

  for (const file of files) {
    const paths = [file.path, file.previous].filter(Boolean);
    if (paths.some(isDatabasePath)) result.database.push(file.path);
    if (file.status === "D") continue;
    if (DEPENDENCY_MANIFESTS.test(file.path)) result.dependencies.push({ path: file.path, kind: "manifest", text: "dependency or package-manager file changed" });
    if (binary.has(file.path) || (file.previous && binary.has(file.previous))) {
      (IMAGE.test(file.path) ? result.images : result.binaries).push(file.path);
      continue;
    }
    const content = show(head, file.path);
    if (!content) continue;
    if (!isValidUtf8(content)) {
      result.malformed.push({ path: file.path, reason: "not valid UTF-8" });
      continue;
    }
    if (/(^|\/)package\.json$/.test(file.path)) {
      const before = file.status === "A" ? null : show(base, file.previous ?? file.path);
      try {
        const old = before ? JSON.parse(before.toString()) : {};
        result.dependencies.push(...packageJsonChanges(file.path, old, JSON.parse(content.toString())));
      } catch {
        result.malformed.push({ path: file.path, reason: "package.json is not valid JSON" });
      }
    }
    const patch = git("diff", "-U0", "--no-color", "--no-ext-diff", "-M", base, head, "--", ...paths).toString();
    const added = addedLineNumbers(patch);
    const lines = content.toString().split(/\r?\n/);
    const checkEncoded = CODE.test(file.path) && !GENERATED.test(file.path);
    const addedLines = [];
    for (const number of [...added].sort((a, b) => a - b)) {
      const line = lines[number - 1];
      if (line === undefined) continue;
      addedLines.push({ number, text: line });
      for (const hit of hiddenCharacters(line, { firstLine: number === 1 })) result.hidden.push({ path: file.path, line: number, ...hit });
      const encoded = checkEncoded ? encodedPayload(line) : null;
      if (encoded) result.encoded.push({ path: file.path, line: number, reason: encoded });
    }
    for (const hit of instructionHits(addedLines)) result.injection.push({ path: file.path, ...hit });
  }
  // Commit messages reach the model too. Each raw commit object is read on
  // its own, so no byte in a message can act as a delimiter and hide the
  // rest. The message starts after the first blank line of the headers.
  const commits = git("rev-list", "--max-count=500", `${base}..${head}`).toString().split("\n").filter(Boolean);
  for (const sha of commits) {
    const raw = git("cat-file", "commit", sha).toString("utf8");
    const split = raw.indexOf("\n\n");
    const message = split === -1 ? "" : raw.slice(split + 2);
    const where = `commit ${sha.slice(0, 10)} message`;
    const messageLines = message.split("\n").map((text, index) => ({ number: index + 1, text }));
    for (const { number, text } of messageLines) {
      for (const hit of hiddenCharacters(text)) result.hidden.push({ path: where, line: number, ...hit });
    }
    for (const hit of instructionHits(messageLines)) result.injection.push({ path: where, ...hit });
  }
  return result;
}

// --- Warden output --------------------------------------------------------------

// Reads Warden CLI JSONL (`-o`). Fails closed: anything unexpected is incomplete.
export function parseWardenJsonl(text, expectedSkills) {
  const records = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return { complete: false, reason: "unreadable-output", findings: [] };
    }
  }
  const summary = records.find((record) => record?.type === "summary");
  if (!summary) return { complete: false, reason: "missing-summary", findings: [] };
  const chunks = records.filter((record) => record !== summary && typeof record?.skill === "string");
  const unexpected = chunks.find((chunk) => !expectedSkills.includes(chunk.skill));
  if (unexpected) return { complete: false, reason: `unexpected-skill:${unexpected.skill}`, findings: [] };
  if (summary.error || summary.failedSkills?.length || summary.totalFailedHunks || summary.totalFailedExtractions ||
      chunks.some((chunk) => chunk.status === "error" || chunk.error)) {
    return { complete: false, reason: "analysis-failed", findings: [] };
  }
  const findings = chunks.flatMap((chunk) => (Array.isArray(chunk.findings) ? chunk.findings : []).map((finding) => ({ ...finding, skill: chunk.skill })));
  const valid = findings.every((finding) => ["high", "medium", "low"].includes(finding.severity) && typeof finding.title === "string");
  if (!valid || findings.length !== summary.totalFindings) return { complete: false, reason: "inconsistent-findings", findings: [] };
  return { complete: true, findings };
}

// --- Decisions ------------------------------------------------------------------

export function screenDecision(scan) {
  const blocked = [];
  const held = [];
  if (scan.hidden.length) blocked.push(`${scan.hidden.length} hidden or look-alike character(s)`);
  if (scan.malformed.length) blocked.push(`${scan.malformed.length} malformed file(s)`);
  if (scan.database.length) held.push("database changes");
  if (scan.dependencies.length) held.push("dependency changes");
  if (scan.binaries.length) held.push("binary files");
  if (scan.encoded.length) held.push("possibly encoded code");
  if (scan.injection?.length) held.push("text aimed at the AI reviewer");
  if (blocked.length) return { verdict: "blocked", state: "failure", description: `Blocked: ${blocked.join(", ")}`, blocked, held };
  if (held.length) return { verdict: "held", state: "pending", description: `Needs maintainer review: ${held.join(", ")}`, blocked, held };
  return { verdict: "clean", state: "success", description: "No hidden characters, dependency, database or obfuscation concerns", blocked, held };
}

// Warden's contributor-screen skill, run only after a maintainer's /test.
export function aiScreenDecision(warden) {
  if (!warden.complete) return { verdict: "flagged", state: "failure", description: `AI screen incomplete (${warden.reason})` };
  const serious = warden.findings.filter((finding) => finding.severity !== "low").length;
  if (serious) return { verdict: "flagged", state: "failure", description: `${serious} high or medium AI screen finding(s)` };
  return { verdict: "clean", state: "success", description: "No hidden behavior, obfuscation or supply-chain concerns found" };
}

export function reviewDecision(warden) {
  if (!warden.complete) return { verdict: "incomplete", state: "failure", description: `Warden review incomplete (${warden.reason})` };
  const confidentiality = warden.findings.filter((finding) => finding.skill === "confidentiality-review").length;
  const serious = warden.findings.filter((finding) => finding.skill === "diff-security-review" && finding.severity !== "low").length;
  if (confidentiality) return { verdict: "flagged", state: "failure", description: `${confidentiality} confidentiality finding(s)` };
  if (serious) return { verdict: "flagged", state: "failure", description: `${serious} high or medium security finding(s)` };
  return { verdict: "clear", state: "success", description: "No high or medium security findings, no confidentiality findings" };
}

// --- Rendering ------------------------------------------------------------------

// Model and contributor text is untrusted: escape it, break @mentions, and
// redact anything shaped like a credential.
export function safe(value, limit = 500) {
  return String(value ?? "")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[\\&<>"`|]/g, (char) => ({ "\\": "\\\\", "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "`": "'", "|": "\\|" })[char])
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => (char === "\u200b" ? char : ""))
    .slice(0, limit);
}

const where = (item) => `\`${safe(item.path, 200)}${item.line ? `:${item.line}${item.endLine ? `-${item.endLine}` : ""}` : ""}\``;
const list = (items, render, max = 20) => [
  ...items.slice(0, max).map((item) => `- ${render(item)}`),
  ...(items.length > max ? [`- …and ${items.length - max} more`] : []),
];

export function renderScreenComment({ sha, decision, scan, runUrl }) {
  const title = { clean: "passed", held: "needs maintainer review", blocked: "blocked" }[decision.verdict];
  const lines = [SCREEN_MARKER, `### Contributor screen: ${title}`, "", `Commit \`${sha.slice(0, 10)}\` · [run](${runUrl})`, ""];
  if (decision.verdict === "clean") {
    lines.push("No hidden characters, dependency, database or obfuscation concerns.");
  }
  if (scan.hidden.length || scan.malformed.length) {
    lines.push("**Hidden or malformed characters.** Remove these and push again; this can't be overridden.", "");
    lines.push(...list(scan.hidden, (hit) => `${where(hit)} column ${hit.column}: ${hit.codePoint} ${hit.name}`));
    lines.push(...list(scan.malformed, (item) => `${where(item)}: ${item.reason}`), "");
  }
  if (scan.database.length) {
    lines.push("**Database changes need a human review** (schema, migrations or migration jobs):", "");
    lines.push(...list(scan.database.map((path) => ({ path })), where), "");
  }
  if (scan.dependencies.length) {
    lines.push("**Dependency changes need a human review:**", "");
    lines.push(...list(scan.dependencies, (item) => `${where(item)}: ${safe(item.text, 300)}`), "");
  }
  if (scan.binaries.length) {
    lines.push("**Binary files need a human review:**", "");
    lines.push(...list(scan.binaries.map((path) => ({ path })), where), "");
  }
  if (scan.encoded.length) {
    lines.push("**Lines that may hide encoded or obfuscated code:**", "");
    lines.push(...list(scan.encoded, (item) => `${where(item)}: ${item.reason}`), "");
  }
  if (scan.injection?.length) {
    lines.push("**Text that looks like instructions to an AI reviewer.** Warden's results on this commit can't be trusted until a person reads these lines:", "");
    lines.push(...list(scan.injection, (item) => `${where(item)}: ${item.reason}`), "");
  }
  if (decision.verdict !== "blocked") {
    lines.push("", "Nothing else runs yet. A maintainer reviews the changes" + (decision.verdict === "held" ? ", including the items above," : "") +
      " then comments `/test` to start the AI screen, the tests and the Warden security review.");
  }
  return lines.join("\n");
}

export function renderAiScreenComment({ sha, decision, warden, runUrl }) {
  const lines = [AI_SCREEN_MARKER, `### AI screen: ${decision.verdict === "clean" ? "clear" : "needs review"}`, "", `Commit \`${sha.slice(0, 10)}\` · [run](${runUrl})`, "", decision.description + "."];
  if (!warden.complete) lines.push("", "The AI screen didn't finish, so it found nothing either way.");
  if (warden.findings.length) {
    lines.push("", ...list(warden.findings, (finding) =>
      `**${finding.severity}**: ${safe(finding.title, 200)}${finding.location?.path ? ` (${where({ path: finding.location.path, line: finding.location.startLine })})` : ""}<br>${safe(finding.description, 800)}`));
  }
  lines.push("", decision.verdict === "clean"
    ? "The tests and the Warden security review are starting."
    : "Tests have not started. Review these findings; to run the tests and security review anyway, comment `/test` again.");
  return lines.join("\n");
}

export function renderReviewComment({ sha, decision, warden, runUrl }) {
  const lines = [WARDEN_MARKER, `### Warden review: ${decision.verdict === "clear" ? "clear" : "not clear"}`, "", `Commit \`${sha.slice(0, 10)}\` · [run](${runUrl})`, "", decision.description + "."];
  const security = warden.findings.filter((finding) => finding.skill === "diff-security-review");
  const confidentiality = warden.findings.length - security.length;
  if (security.length) {
    lines.push("", ...list(security, (finding) =>
      `**${finding.severity}**: ${safe(finding.title, 200)}${finding.location?.path ? ` (${where({ path: finding.location.path, line: finding.location.startLine })})` : ""}<br>${safe(finding.description, 800)}`));
  }
  // Confidentiality findings could name the identity the rule protects.
  if (confidentiality) lines.push("", `${confidentiality} confidentiality finding(s); details are in the run log for maintainers.`);
  return lines.join("\n");
}

// --- GitHub I/O -----------------------------------------------------------------

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github(path, init = {}, attempt = 0) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env("GH_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  // Out of API quota: wait for the reset (at most an hour) and try again.
  if ((response.status === 403 || response.status === 429) && attempt < 3 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after"))) {
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const wait = Math.min(Math.max(reset - Date.now(), Number(response.headers.get("retry-after") ?? 0) * 1000, 30_000), 3_600_000);
    console.log(`Rate limited on ${path}; waiting ${Math.round(wait / 1000)}s.`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return github(path, init, attempt + 1);
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function upsertComment(repo, number, marker, body) {
  const comments = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await github(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const mine = comments.find((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker));
  if (mine) await github(`/repos/${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
  else await github(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

async function setStatus(repo, sha, context, { state, description }, url) {
  await github(`/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    body: JSON.stringify({ state, context, description: description.slice(0, 140), target_url: url }),
  });
}

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function main(mode) {
  if (mode === "scan") {
    const scan = scanRepository({ gitDir: env("PR_GIT_DIR"), base: env("MERGE_BASE"), head: env("HEAD_SHA") });
    await writeFile(env("SCAN_PATH"), JSON.stringify(scan, null, 2));
    console.log(JSON.stringify({ ...scan, files: scan.files.length }, null, 2));
    return;
  }

  const repo = env("GITHUB_REPOSITORY");
  const number = Number(env("PR_NUMBER"));
  const sha = env("HEAD_SHA");
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;

  if (mode === "report") {
    const scan = JSON.parse(await readFile(env("SCAN_PATH"), "utf8"));
    const decision = screenDecision(scan);
    await setStatus(repo, sha, SCREEN_CONTEXT, decision, runUrl);
    await upsertComment(repo, number, SCREEN_MARKER, renderScreenComment({ sha, decision, scan, runUrl }));
    await output("verdict", decision.verdict);
    console.log(`${SCREEN_CONTEXT} on ${sha}: ${decision.verdict} (${decision.description})`);
    return;
  }

  if (mode === "ai-screen") {
    const warden = parseWardenJsonl(await readOptional(env("WARDEN_JSONL")), ["contributor-screen"]);
    const decision = aiScreenDecision(warden);
    await setStatus(repo, sha, AI_SCREEN_CONTEXT, decision, runUrl);
    if (decision.verdict !== "clean") {
      // Tests and the security review wait; say so on the required check.
      await setStatus(repo, sha, "contributor-pr-required", {
        state: "pending", description: "AI screen needs review; comment /test again to run tests anyway",
      }, runUrl);
    }
    await upsertComment(repo, number, AI_SCREEN_MARKER, renderAiScreenComment({ sha, decision, warden, runUrl }));
    await output("verdict", decision.verdict);
    console.log(`${AI_SCREEN_CONTEXT} on ${sha}: ${decision.verdict} (${decision.description})`);
    return;
  }

  if (mode === "review") {
    const warden = parseWardenJsonl(await readOptional(env("WARDEN_JSONL")), ["diff-security-review", "confidentiality-review"]);
    const decision = reviewDecision(warden);
    await setStatus(repo, sha, WARDEN_CONTEXT, decision, runUrl);
    await upsertComment(repo, number, WARDEN_MARKER, renderReviewComment({ sha, decision, warden, runUrl }));
    await output("verdict", decision.verdict);
    console.log(`${WARDEN_CONTEXT} on ${sha}: ${decision.verdict} (${decision.description})`);
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
