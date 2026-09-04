import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { renderPrMarkdown } from "./render.ts";
import { readTestRunDirectory } from "./scan.ts";

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

export interface PublishDependencies {
  exec?: CommandRunner;
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

interface Attachment {
  fileName: string;
  absPath: string;
  caption: string;
}

function ghSupportsAttach(exec: CommandRunner): boolean {
  return exec("gh", ["pr", "comment", "--help"]).stdout.includes("--attach");
}

function sanitizeCaption(caption: string, fileName: string): string {
  return caption.replace(/[\r\n#]/g, "").trim() || fileName;
}

async function resolveAttachments(
  testRunDir: string,
  fileNames: Array<{ fileName: string; caption: string }>,
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  const realDir = await realpath(testRunDir);
  for (const { fileName, caption } of fileNames) {
    if (basename(fileName) !== fileName || !fileName.toLowerCase().endsWith(".png")) {
      throw new Error(`Refusing to attach invalid test artifact path: ${fileName}`);
    }
    const absPath = join(realDir, fileName);
    const stats = await lstat(absPath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Refusing to attach non-regular or symlinked test artifact: ${fileName}`);
    }
    attachments.push({ fileName, absPath, caption: sanitizeCaption(caption, fileName) });
  }
  return attachments;
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

function postStickyComment(pr: string, markdown: string, attachments: Attachment[], exec: CommandRunner): boolean {
  const viewed = exec("gh", ["pr", "view", pr, "--json", "comments"]);
  requireSuccess(viewed, "Reading PR comments");
  const commentId = stickyCommentId(viewed.stdout);
  if (commentId) {
    const deleted = exec(
      "gh",
      ["api", "--method", "DELETE", `repos/{owner}/{repo}/issues/comments/${commentId}`],
    );
    requireSuccess(deleted, "Deleting previous test evidence comment");
  }
  const attachmentArgs = attachments.flatMap((attachment) => ["--attach", `${attachment.absPath}#${attachment.caption}`]);
  const posted = exec("gh", ["pr", "comment", pr, "--body-file", "-", ...attachmentArgs], { input: markdown });
  requireSuccess(posted, "Posting test evidence comment");
  return commentId !== null;
}

export async function publishPr(
  options: PublishPrOptions,
  dependencies: PublishDependencies = {},
): Promise<PublishPrResult> {
  const stored = await readTestRunDirectory(options.testRunDir);
  if (!stored) throw new Error(`No valid test-run.json or legacy result found in ${options.testRunDir}`);
  const { format, testRun } = stored;
  const exec = dependencies.exec ?? commandRunner;
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
      notice: "Dry run: screenshots were not attached.",
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

  const uniqueArtifacts = testRun.artifacts.filter((artifact, index, artifacts) =>
    artifact.fileName.length > 0 && artifacts.findIndex((candidate) => candidate.fileName === artifact.fileName) === index
  );
  const attachments = await resolveAttachments(options.testRunDir, uniqueArtifacts);
  const supportsAttach = ghSupportsAttach(exec);
  const postedAttachments = supportsAttach ? attachments : [];
  const urls = Object.fromEntries(postedAttachments.map((attachment) => [attachment.fileName, attachment.absPath]));
  const attachmentNotice = supportsAttach ? undefined : "screenshots not attached (gh < 2.99; run `brew upgrade gh`)";
  const markdown = renderPrMarkdown(testRun, urls, {
    reproCommand,
    sourcePath,
    notice: [staleNotice, attachmentNotice].filter((notice) => notice !== undefined).join(" · ") || undefined,
  });
  const updated = postStickyComment(String(options.pr), markdown, postedAttachments, exec);
  return { markdown, posted: true, updated, urls };
}
