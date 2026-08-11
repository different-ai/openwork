import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { renderPrMarkdown } from "./render.ts";
import { readRollFile } from "./scan.ts";

const BLOB_API_BASE = "https://blob.vercel-storage.com";
const MARKER = "<!-- photo-roll -->";

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
  /** Deliberately publish the verdict without uploading frames. */
  noScreenshots?: boolean;
}

export interface PublishPrResult {
  markdown: string;
  posted: boolean;
  updated: boolean;
  urls: Record<string, string>;
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

type BlobTokenResolution =
  | { token: string }
  | { token: null; detail: string };

function resolveBlobToken(exec: CommandRunner): BlobTokenResolution {
  const fromEnv = process.env.BLOB_READ_WRITE_TOKEN;
  if (fromEnv) return { token: fromEnv };
  const result = exec(
    "infisical",
    ["secrets", "get", "BLOB_READ_WRITE_TOKEN", "--plain", "--silent"],
  );
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
    return { token: null, detail: `the infisical fallback failed (${detail})` };
  }
  const token = result.stdout.trim();
  if (token.length === 0) return { token: null, detail: "the infisical fallback returned an empty token" };
  return { token };
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

function stickyCommentId(raw: string): string | null {
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
    if (typeof directId === "number" && Number.isInteger(directId)) return String(directId);
    if (typeof directId === "string" && /^\d+$/.test(directId)) return directId;
    if (typeof comment.url === "string") {
      const match = /#issuecomment-(\d+)$/.exec(comment.url);
      if (match?.[1]) return match[1];
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

function resolvePrHeadSha(pr: string, exec: CommandRunner): string {
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

function postStickyComment(pr: string, markdown: string, exec: CommandRunner): boolean {
  const viewed = exec("gh", ["pr", "view", pr, "--json", "comments"]);
  requireSuccess(viewed, "Reading PR comments");
  const commentId = stickyCommentId(viewed.stdout);
  if (commentId) {
    const updated = exec(
      "gh",
      ["api", "--method", "PATCH", `repos/{owner}/{repo}/issues/comments/${commentId}`, "--input", "-"],
      { input: JSON.stringify({ body: markdown }) },
    );
    requireSuccess(updated, "Updating photo roll comment");
    return true;
  }
  const posted = exec("gh", ["pr", "comment", pr, "--body-file", "-"], { input: markdown });
  requireSuccess(posted, "Posting photo roll comment");
  return false;
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
  const reproCommand = `pnpm fraimz:publish -- --pr ${pr} --roll ${rollName}`;

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

  const frames = [...new Set(roll.frames.map((frame) => frame.fileName).filter((fileName) => fileName.length > 0))];
  let urls: Record<string, string> = {};
  let uploadNotice: string | undefined;
  if (options.noScreenshots) {
    uploadNotice = "screenshots not uploaded (--no-screenshots)";
  } else {
    const resolved = resolveBlobToken(exec);
    if (resolved.token !== null) {
      urls = await uploadImages(options.rollDir, rollName, frames, resolved.token, fetcher);
    } else if (frames.length > 0) {
      // Posting a frameful roll without its frames silently degrades the
      // evidence; require the operator to fix the token or opt out explicitly.
      throw new Error(
        `Refusing to publish ${frames.length} frame${frames.length === 1 ? "" : "s"} without screenshots: `
        + `BLOB_READ_WRITE_TOKEN is unset and ${resolved.detail}. `
        + 'Export it with `export BLOB_READ_WRITE_TOKEN="$(infisical secrets get BLOB_READ_WRITE_TOKEN --plain --silent)"`, '
        + "or pass --no-screenshots to deliberately publish the verdict without frames.",
      );
    } else {
      uploadNotice = "screenshots not uploaded (no BLOB_READ_WRITE_TOKEN)";
    }
  }
  const markdown = renderPrMarkdown(roll, urls, {
    reproCommand,
    notice: [staleNotice, uploadNotice].filter((notice) => notice !== undefined).join(" · ") || undefined,
  });
  const updated = postStickyComment(String(options.pr), markdown, exec);
  return { markdown, posted: true, updated, urls };
}
