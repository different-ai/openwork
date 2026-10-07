#!/usr/bin/env node
// Contributor screen: the first layer of checks on every push to a fork PR,
// before any of its code runs anywhere.
//
//   scan    deterministic checks over the PR's changes, read from git objects
//           and a checkout that is never executed: hidden or malformed
//           characters, dependency and install-script changes, database
//           changes, binaries, and code that looks encoded or obfuscated.
//   report  joins the scan with Warden's contributor-screen findings, sets
//           the `contributor-pr/screen` status and updates one PR comment.
//   review  reads a standard Warden run (diff-security-review and
//           confidentiality-review), sets `contributor-pr/warden` and
//           updates one PR comment.
//
// Runs only from the default branch. Never install, build, or run PR code.
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const SCREEN_CONTEXT = "contributor-pr/screen";
export const WARDEN_CONTEXT = "contributor-pr/warden";
const SCREEN_MARKER = "<!-- contributor-pr:screen -->";
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
  for (const match of line.matchAll(/[\p{L}\p{M}\p{N}_$]+/gu)) {
    const token = match[0];
    if (/[A-Za-z]/.test(token) && CONFUSABLE_SCRIPTS.test(token)) {
      found.push({ column: [...line.slice(0, match.index)].length + 1, codePoint: "mixed", name: "MIXED-SCRIPT IDENTIFIER (look-alike letters)" });
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
  const result = { files: files.map((file) => file.path), hidden: [], malformed: [], dependencies: [], database: [], binaries: [], images: [], encoded: [] };

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
    for (const number of added) {
      const line = lines[number - 1];
      if (line === undefined) continue;
      for (const hit of hiddenCharacters(line, { firstLine: number === 1 })) result.hidden.push({ path: file.path, line: number, ...hit });
      const encoded = checkEncoded ? encodedPayload(line) : null;
      if (encoded) result.encoded.push({ path: file.path, line: number, reason: encoded });
    }
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

export function screenDecision(scan, warden) {
  const blocked = [];
  const held = [];
  if (scan.hidden.length) blocked.push(`${scan.hidden.length} hidden or look-alike character(s)`);
  if (scan.malformed.length) blocked.push(`${scan.malformed.length} malformed file(s)`);
  if (scan.database.length) held.push("database changes");
  if (scan.dependencies.length) held.push("dependency changes");
  if (scan.binaries.length) held.push("binary files");
  if (scan.encoded.length) held.push("possibly encoded code");
  if (!warden.complete) held.push("Warden screen incomplete");
  const serious = warden.findings.filter((finding) => finding.severity !== "low");
  if (serious.length) held.push(`${serious.length} Warden finding(s)`);
  if (blocked.length) return { verdict: "blocked", state: "failure", description: `Blocked: ${blocked.join(", ")}`, blocked, held };
  if (held.length) return { verdict: "held", state: "pending", description: `Held for maintainer review: ${held.join(", ")}`, blocked, held };
  return { verdict: "clean", state: "success", description: "No hidden characters, dependency, database or obfuscation concerns", blocked, held };
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
    .replace(/[&<>"`|]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "`": "'", "|": "\\|" })[char])
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => (char === "\u200b" ? char : ""))
    .slice(0, limit);
}

const where = (item) => `\`${safe(item.path, 200)}${item.line ? `:${item.line}` : ""}\``;
const list = (items, render, max = 20) => [
  ...items.slice(0, max).map((item) => `- ${render(item)}`),
  ...(items.length > max ? [`- …and ${items.length - max} more`] : []),
];

export function renderScreenComment({ sha, decision, scan, warden, runUrl }) {
  const title = { clean: "passed", held: "held for maintainer review", blocked: "blocked" }[decision.verdict];
  const lines = [SCREEN_MARKER, `### Contributor screen: ${title}`, "", `Commit \`${sha.slice(0, 10)}\` · [run](${runUrl})`, ""];
  if (decision.verdict === "clean") {
    lines.push("No hidden characters, dependency, database or obfuscation concerns. Tests and the Warden security review run next.");
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
  if (!warden.complete) lines.push(`**Warden screen did not finish** (\`${safe(warden.reason, 80)}\`). A maintainer must review by hand or re-run it.`, "");
  if (warden.findings.length) {
    lines.push("**Warden contributor screen:**", "");
    lines.push(...list(warden.findings, (finding) =>
      `**${finding.severity}**: ${safe(finding.title, 200)}${finding.location?.path ? ` (${where({ path: finding.location.path, line: finding.location.startLine })})` : ""}<br>${safe(finding.description, 800)}`));
    lines.push("");
  }
  if (decision.verdict === "held") {
    lines.push("A maintainer reviews the items above, then comments `/test` to run the tests and the Warden security review.");
  }
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

async function github(path, init = {}) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env("GH_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
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
    const warden = parseWardenJsonl(await readOptional(env("WARDEN_JSONL")), ["contributor-screen"]);
    const decision = screenDecision(scan, warden);
    await setStatus(repo, sha, SCREEN_CONTEXT, decision, runUrl);
    await upsertComment(repo, number, SCREEN_MARKER, renderScreenComment({ sha, decision, scan, warden, runUrl }));
    await output("verdict", decision.verdict);
    console.log(`${SCREEN_CONTEXT} on ${sha}: ${decision.verdict} (${decision.description})`);
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
