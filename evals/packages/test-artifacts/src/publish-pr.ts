import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { renderPrMarkdown } from "./render.ts";
import { readTestRunDirectory } from "./scan.ts";

const BLOB_API_BASE = "https://blob.vercel-storage.com";
const MARKER = "<!-- test-evidence -->";
const LEGACY_MARKERS = ["<!-- photo-roll -->", "<!-- fraimz -->"];

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
  testRunDir: string;
  dryRun?: boolean;
  force?: boolean;
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

export function formatTestRunAge(createdAt: string, now = Date.now()): string {
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
  testRunDir: string,
  testRunId: string,
  files: string[],
  token: string,
  fetcher: Fetcher,
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const realDir = await realpath(testRunDir);
  for (const file of files) {
    if (basename(file) !== file || !file.toLowerCase().endsWith(".png")) {
      throw new Error(`Refusing to upload invalid test artifact path: ${file}`);
    }
    const filePath = join(realDir, file);
    const stats = await lstat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Refusing to upload non-regular or symlinked test artifact: ${file}`);
    }
    const pathname = `test-artifacts/${encodeURIComponent(testRunId)}/${encodeURIComponent(file)}`;
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
  const markers = [MARKER, ...LEGACY_MARKERS];
  for (const comment of value.comments) {
    if (!isRecord(comment) || typeof comment.body !== "string") continue;
    const body = comment.body;
    if (!markers.some((marker) => body.includes(marker))) continue;
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
    requireSuccess(updated, "Updating test evidence comment");
    return true;
  }
  const posted = exec("gh", ["pr", "comment", pr, "--body-file", "-"], { input: markdown });
  requireSuccess(posted, "Posting test evidence comment");
  return false;
}

export async function publishPr(
  options: PublishPrOptions,
  dependencies: PublishDependencies = {},
): Promise<PublishPrResult> {
  const stored = await readTestRunDirectory(options.testRunDir);
  if (!stored) throw new Error(`No valid test-run.json or legacy result found in ${options.testRunDir}`);
  const { format, testRun } = stored;
  const exec = dependencies.exec ?? commandRunner;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const testRunId = basename(options.testRunDir);
  const pr = options.pr === undefined ? "<n>" : String(options.pr);
  const reproCommand = `pnpm --dir evals artifacts:publish -- --pr ${pr} --test-run ${testRunId}`;
  const sourcePath = format === "current"
    ? `evals/results/test-runs/${testRunId}/test-run.json`
    : `evals/results/rolls/${testRunId}/roll.json`;

  if (options.dryRun) {
    const markdown = renderPrMarkdown(testRun, {}, {
      reproCommand,
      sourcePath,
      notice: "Dry run: screenshots were not uploaded.",
    });
    (dependencies.stdout ?? ((body) => process.stdout.write(`${body}\n`)))(markdown);
    return { markdown, posted: false, updated: false, urls: {} };
  }
  if (options.pr === undefined) throw new Error("Publishing requires --pr <n>.");

  if (!testRun.gitSha) {
    throw new Error(`Refusing to publish ${testRunId}: stored test evidence has no gitSha (${formatTestRunAge(testRun.createdAt)}).`);
  }
  const prHeadSha = resolvePrHeadSha(String(options.pr), exec);
  const stale = testRun.gitSha.toLowerCase() !== prHeadSha.toLowerCase();
  if (stale && !options.force) {
    throw new Error(`Refusing stale evidence: test run SHA ${testRun.gitSha}, PR head SHA ${prHeadSha} (${formatTestRunAge(testRun.createdAt)}). Use --force to publish it anyway.`);
  }
  const staleNotice = stale
    ? `⚠ evidence from ${shortSha(testRun.gitSha)}, PR head is ${shortSha(prHeadSha)}`
    : undefined;

  const token = resolveBlobToken(exec);
  const urls = token
    ? await uploadImages(
      options.testRunDir,
      testRunId,
      [...new Set(testRun.artifacts.map((artifact) => artifact.fileName).filter((fileName) => fileName.length > 0))],
      token,
      fetcher,
    )
    : {};
  const uploadNotice = token ? undefined : "screenshots not uploaded (no BLOB_READ_WRITE_TOKEN)";
  const markdown = renderPrMarkdown(testRun, urls, {
    reproCommand,
    sourcePath,
    notice: [staleNotice, uploadNotice].filter((notice) => notice !== undefined).join(" · ") || undefined,
  });
  const updated = postStickyComment(String(options.pr), markdown, exec);
  return { markdown, posted: true, updated, urls };
}
