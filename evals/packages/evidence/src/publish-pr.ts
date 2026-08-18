import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { renderPrMarkdown } from "./render.ts";
import { readRollFile } from "./scan.ts";
import type { PhotoRollRecord } from "./schema.ts";

const BLOB_API_BASE = "https://blob.vercel-storage.com";
const MARKER = "<!-- photo-roll -->";
const FRAIMZ_MARKER = "<!-- fraimz -->";
const END_MARKER = "<!-- /photo-roll -->";
const SECTION_PATTERN = /<!-- photo-roll-section slug=([^ ]+) createdAt=([^ ]+) verdict=([^ ]+) name=([^ ]*) -->\n([\s\S]*?)\n<!-- \/photo-roll-section -->/g;

export interface CommandOptions {
  input?: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (command: string, args: string[], opts?: CommandOptions) => CommandResult;
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PublishDependencies {
  exec?: CommandRunner;
  fetch?: Fetcher;
  stdout?: (markdown: string) => void;
}

export interface PublishPrOptions {
  pr?: string | number;
  rollDir: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface PublishPrResult {
  markdown: string;
  posted: boolean;
  updated: boolean;
  urls: Record<string, string>;
}

export type EvidenceVerdict = "passed" | "failed" | "unvalidated";

export interface PrEvidenceSection {
  slug: string;
  name: string;
  createdAt: string;
  verdict: EvidenceVerdict;
  markdown: string;
}

export interface PublishPrRollsOptions {
  pr: string | number;
  rollDirs: string[];
}

export interface PublishPrRollsResult {
  markdown: string;
  posted: boolean;
  updated: boolean;
  urls: Record<string, Record<string, string>>;
  skipped: string[];
}

function commandRunner(command: string, args: string[], opts: CommandOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: opts.input,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function evidenceSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "roll";
}

function isVerdict(value: string): value is EvidenceVerdict {
  return value === "passed" || value === "failed" || value === "unvalidated";
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function stripCommentMarkers(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => line !== MARKER && line !== FRAIMZ_MARKER && line !== END_MARKER)
    .join("\n")
    .trim();
}

function parseSections(body: string): PrEvidenceSection[] {
  const sections: PrEvidenceSection[] = [];
  for (const match of body.matchAll(SECTION_PATTERN)) {
    const [, slug, encodedCreatedAt, verdict, encodedName, markdown] = match;
    if (!slug || !encodedCreatedAt || !verdict || encodedName === undefined || !markdown || !isVerdict(verdict)) continue;
    const createdAt = decode(encodedCreatedAt);
    const name = decode(encodedName);
    if (createdAt === null || name === null) continue;
    sections.push({ slug, name, createdAt, verdict, markdown });
  }
  return sections;
}

function legacySection(body: string): PrEvidenceSection | null {
  if (!body.includes(MARKER)) return null;
  const markdown = stripCommentMarkers(body);
  if (!markdown) return null;
  const title = /^## Photo roll — (.+?) — /m.exec(markdown)?.[1];
  const directoryName = /Source: `evals\/results\/rolls\/([^/`]+)\/roll\.json`/.exec(markdown)?.[1];
  const directorySlug = directoryName?.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, "");
  const createdAt = /_Roll created ([^ ·]+)/.exec(markdown)?.[1] ?? "0000-00-00T00:00:00.000Z";
  const icon = /^(✅|❌|⚪) \*\*/m.exec(markdown)?.[1];
  const verdict: EvidenceVerdict = icon === "✅" ? "passed" : icon === "❌" ? "failed" : "unvalidated";
  return {
    slug: directorySlug || evidenceSlug(title ?? "previous-evidence"),
    name: title ?? directorySlug ?? "Previous evidence",
    createdAt,
    verdict,
    markdown,
  };
}

function verdictLabel(verdict: EvidenceVerdict): string {
  if (verdict === "passed") return "✅ PASSED";
  if (verdict === "failed") return "❌ FAILED";
  return "⚪ UNVALIDATED";
}

function renderSection(section: PrEvidenceSection): string {
  const marker = `<!-- photo-roll-section slug=${section.slug} createdAt=${encodeURIComponent(section.createdAt)} verdict=${section.verdict} name=${encodeURIComponent(section.name)} -->`;
  return `${marker}\n${section.markdown.trim()}\n<!-- /photo-roll-section -->`;
}

export function composePrComment(
  existingBody: string | null | undefined,
  incoming: PrEvidenceSection | PrEvidenceSection[],
): string {
  const existing = existingBody ? parseSections(existingBody) : [];
  if (existingBody && existing.length === 0) {
    const legacy = legacySection(existingBody);
    if (legacy) existing.push(legacy);
  }
  const sections = new Map<string, PrEvidenceSection>();
  for (const section of [...existing, ...(Array.isArray(incoming) ? incoming : [incoming])]) {
    sections.set(section.slug, section);
  }
  const ordered = [...sections.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.slug.localeCompare(right.slug)
  ));
  const summary = ordered.map((section) => `- ${verdictLabel(section.verdict)} — **${html(section.name)}**`).join("\n");
  const details = ordered.map(renderSection).join("\n\n");
  return [
    MARKER,
    FRAIMZ_MARKER,
    "## Testkit evidence",
    "",
    summary,
    "",
    details,
    END_MARKER,
  ].join("\n");
}

export function formatRollAge(createdAt: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(createdAt));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function rollVerdict(roll: PhotoRollRecord): EvidenceVerdict {
  if (roll.summary.ok) return "passed";
  if (roll.summary.failedFrames > 0 || roll.summary.failedExpectations > 0) return "failed";
  return "unvalidated";
}

function evidenceSection(
  roll: PhotoRollRecord,
  markdown: string,
): PrEvidenceSection {
  return {
    slug: evidenceSlug(roll.name),
    name: roll.name,
    createdAt: roll.createdAt,
    verdict: rollVerdict(roll),
    markdown: stripCommentMarkers(markdown),
  };
}

function resolveBlobToken(exec: CommandRunner): string | null {
  const fromEnv = process.env.BLOB_READ_WRITE_TOKEN;
  if (fromEnv) return fromEnv;
  const result = exec(
    "infisical",
    ["secrets", "get", "BLOB_READ_WRITE_TOKEN", "--plain", "--silent"],
  );
  const token = result.status === 0 && !result.error ? result.stdout.trim() : "";
  return token.length > 0 ? token : null;
}

async function uploadImages(
  rollDir: string,
  rollName: string,
  files: string[],
  token: string,
  fetcher: Fetcher,
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const realDir = await realpath(rollDir);
  for (const file of files) {
    if (basename(file) !== file || !file.toLowerCase().endsWith(".png")) {
      throw new Error(`Refusing to upload invalid roll frame path: ${file}`);
    }
    const filePath = join(realDir, file);
    const stats = await lstat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Refusing to upload non-regular or symlinked roll frame: ${file}`);
    }
    const pathname = `photo-roll/${encodeURIComponent(rollName)}/${encodeURIComponent(file)}`;
    const response = await fetcher(`${BLOB_API_BASE}/${pathname}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-content-type": "image/png",
        "x-add-random-suffix": "0",
      },
      body: await readFile(filePath),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Vercel Blob upload failed (${response.status}) for ${file}: ${detail}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Vercel Blob upload for ${file}: response was not JSON`);
    }
    if (!isRecord(payload) || typeof payload.url !== "string" || payload.url.length === 0) {
      throw new Error(`Vercel Blob upload for ${file}: response did not include a url`);
    }
    urls[file] = payload.url;
  }
  return urls;
}

interface StickyComment {
  id: string;
  body: string;
}

function stickyComment(raw: string): StickyComment | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.comments)) return null;
  for (const comment of value.comments) {
    if (!isRecord(comment) || typeof comment.body !== "string" || !comment.body.includes(MARKER)) continue;
    const directId = comment.databaseId ?? comment.id;
    if (typeof directId === "number" && Number.isInteger(directId)) return { id: String(directId), body: comment.body };
    if (typeof directId === "string" && /^\d+$/.test(directId)) return { id: directId, body: comment.body };
    if (typeof comment.url === "string") {
      const match = /#issuecomment-(\d+)$/.exec(comment.url);
      if (match?.[1]) return { id: match[1], body: comment.body };
    }
  }
  return null;
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.status === 0 && !result.error) return;
  const stderr = result.stderr.trim();
  const detail = result.error?.message ?? (stderr || `exit ${result.status}`);
  throw new Error(`${label} failed: ${detail}`);
}

export function resolvePrHeadSha(pr: string, exec: CommandRunner = commandRunner): string {
  const viewed = exec("gh", ["pr", "view", pr, "--json", "headRefOid"]);
  if (viewed.status !== 0 || viewed.error) {
    const detail = viewed.error?.message ?? viewed.stderr.trim();
    throw new Error(`Unable to resolve PR head SHA with gh${detail ? `: ${detail}` : "."} Install GitHub CLI if needed, then run \`gh auth login\`.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(viewed.stdout);
  } catch {
    throw new Error("Unable to resolve PR head SHA with gh: response was not JSON. Run `gh auth login` and try again.");
  }
  if (!isRecord(payload) || typeof payload.headRefOid !== "string" || payload.headRefOid.length === 0) {
    throw new Error("Unable to resolve PR head SHA with gh: response did not include headRefOid. Run `gh auth login` and try again.");
  }
  return payload.headRefOid;
}

function postStickyComment(
  pr: string,
  sections: PrEvidenceSection[],
  exec: CommandRunner,
): { markdown: string; updated: boolean } {
  const viewed = exec("gh", ["pr", "view", pr, "--json", "comments"]);
  requireSuccess(viewed, "Reading PR comments");
  const comment = stickyComment(viewed.stdout);
  const markdown = composePrComment(comment?.body, sections);
  if (comment) {
    const updated = exec(
      "gh",
      ["api", "--method", "PATCH", `repos/{owner}/{repo}/issues/comments/${comment.id}`, "--input", "-"],
      { input: JSON.stringify({ body: markdown }) },
    );
    requireSuccess(updated, "Updating photo roll comment");
    return { markdown, updated: true };
  }
  const posted = exec("gh", ["pr", "comment", pr, "--body-file", "-"], { input: markdown });
  requireSuccess(posted, "Posting photo roll comment");
  return { markdown, updated: false };
}

async function prepareEvidenceSection(
  rollDir: string,
  roll: PhotoRollRecord,
  pr: string,
  token: string | null,
  fetcher: Fetcher,
  staleNotice?: string,
): Promise<{ section: PrEvidenceSection; urls: Record<string, string> }> {
  const rollName = basename(rollDir);
  const urls = token
    ? await uploadImages(
      rollDir,
      rollName,
      [...new Set(roll.frames.map((frame) => frame.fileName).filter((fileName) => fileName.length > 0))],
      token,
      fetcher,
    )
    : {};
  const uploadNotice = token ? undefined : "screenshots not uploaded (no BLOB_READ_WRITE_TOKEN)";
  const markdown = renderPrMarkdown(roll, urls, {
    reproCommand: `pnpm fraimz:publish -- --pr ${pr} --roll ${rollName}`,
    notice: [staleNotice, uploadNotice].filter((notice) => notice !== undefined).join(" · ") || undefined,
  });
  return { section: evidenceSection(roll, markdown), urls };
}

function writeMessage(dependencies: PublishDependencies, message: string): void {
  (dependencies.stdout ?? ((body) => process.stdout.write(`${body}\n`)))(message);
}

export async function publishPr(
  options: PublishPrOptions,
  dependencies: PublishDependencies = {},
): Promise<PublishPrResult> {
  const roll = await readRollFile(join(options.rollDir, "roll.json"));
  if (!roll) throw new Error(`No valid roll.json found in ${options.rollDir}`);
  const exec = dependencies.exec ?? commandRunner;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const rollName = basename(options.rollDir);
  const pr = options.pr === undefined ? "<n>" : String(options.pr);
  const reproCommand = `pnpm evals --publish --pr ${pr} --roll ${rollName}`;

  if (options.dryRun) {
    const markdown = renderPrMarkdown(roll, {}, {
      reproCommand,
      notice: "Dry run: screenshots were not uploaded.",
    });
    (dependencies.stdout ?? ((body) => process.stdout.write(`${body}\n`)))(markdown);
    return { markdown, posted: false, updated: false, urls: {} };
  }
  if (options.pr === undefined) throw new Error("Publishing requires --pr <n>.");

  if (!roll.gitSha) {
    throw new Error(`Refusing to publish ${rollName}: roll.json has no gitSha (${formatRollAge(roll.createdAt)}).`);
  }
  const prHeadSha = resolvePrHeadSha(String(options.pr), exec);
  const stale = roll.gitSha.toLowerCase() !== prHeadSha.toLowerCase();
  if (stale && !options.force) {
    throw new Error(`Refusing stale evidence: roll SHA ${roll.gitSha}, PR head SHA ${prHeadSha} (${formatRollAge(roll.createdAt)}). Use --force to publish it anyway.`);
  }
  const staleNotice = stale
    ? `⚠ evidence from ${shortSha(roll.gitSha)}, PR head is ${shortSha(prHeadSha)}`
    : undefined;

  const prepared = await prepareEvidenceSection(
    options.rollDir,
    roll,
    String(options.pr),
    resolveBlobToken(exec),
    fetcher,
    staleNotice,
  );
  const posted = postStickyComment(String(options.pr), [prepared.section], exec);
  return { markdown: posted.markdown, posted: true, updated: posted.updated, urls: prepared.urls };
}

export async function publishPrRolls(
  options: PublishPrRollsOptions,
  dependencies: PublishDependencies = {},
): Promise<PublishPrRollsResult> {
  const exec = dependencies.exec ?? commandRunner;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const pr = String(options.pr);
  const prHeadSha = resolvePrHeadSha(pr, exec);
  const skipped: string[] = [];
  const matching: { rollDir: string; roll: PhotoRollRecord }[] = [];

  for (const rollDir of options.rollDirs) {
    const rollName = basename(rollDir);
    const roll = await readRollFile(join(rollDir, "roll.json"));
    let reason: string | undefined;
    if (!roll) reason = "unreadable or malformed roll.json";
    else if (!roll.gitSha) reason = "roll.json has no gitSha";
    else if (roll.gitSha.toLowerCase() !== prHeadSha.toLowerCase()) {
      reason = `roll SHA ${shortSha(roll.gitSha)} does not match PR head ${shortSha(prHeadSha)}`;
    }
    if (reason) {
      const message = `Skipping ${rollName}: ${reason}.`;
      skipped.push(message);
      writeMessage(dependencies, message);
      continue;
    }
    if (roll) matching.push({ rollDir, roll });
  }

  matching.sort((left, right) => (
    left.roll.createdAt.localeCompare(right.roll.createdAt)
    || basename(left.rollDir).localeCompare(basename(right.rollDir))
  ));
  if (matching.length === 0) {
    throw new Error(`No photo rolls match PR head SHA ${prHeadSha}.`);
  }

  const token = resolveBlobToken(exec);
  const sections: PrEvidenceSection[] = [];
  const urls: Record<string, Record<string, string>> = {};
  for (const entry of matching) {
    const prepared = await prepareEvidenceSection(entry.rollDir, entry.roll, pr, token, fetcher);
    sections.push(prepared.section);
    urls[basename(entry.rollDir)] = prepared.urls;
  }
  const posted = postStickyComment(pr, sections, exec);
  return {
    markdown: posted.markdown,
    posted: true,
    updated: posted.updated,
    urls,
    skipped,
  };
}
