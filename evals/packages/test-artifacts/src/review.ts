import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  docShotReceiptSchema,
  reviewSchema,
  summarizeReview,
} from "@openwork/review";
import type { ReviewReport } from "@openwork/review";
import type { ReviewAsset } from "@openwork/review/storage";
import { readTestRunDirectory } from "./scan.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);

async function regularFile(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 25 * 1024 * 1024)
    throw new Error(`Invalid or oversized evidence file: ${basename(path)}`);
  return readFile(path);
}

export async function assembleReview(options: {
  testRunDirs: string[];
  docShots?: string[];
  title?: string;
  gaps?: string[];
}): Promise<{ report: ReviewReport; assets: ReviewAsset[] }> {
  const sources: ReviewReport["sources"] = [];
  const sections: ReviewReport["sections"] = [];
  const evidence: ReviewReport["evidence"] = [];
  const assets = new Map<string, ReviewAsset>();
  async function image(path: string) {
    const body = await regularFile(path);
    if (
      !body
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error(`Invalid PNG: ${basename(path)}`);
    const name = `${createHash("sha256").update(body).digest("hex")}.png`;
    assets.set(name, { name, body });
    return name;
  }
  for (const directory of [...new Set(options.testRunDirs)]) {
    const stored = await readTestRunDirectory(directory);
    if (!stored?.testRun.gitSha)
      throw new Error(`No committed test evidence in ${directory}`);
    const run = stored.testRun;
    const sourceId = `run-${digest(`${run.gitSha}:${run.name}:${run.createdAt}`)}`;
    if (sources.some((source) => source.id === sourceId)) continue;
    const sourceAsset = `${sourceId}.json`;
    assets.set(sourceAsset, {
      name: sourceAsset,
      body: await regularFile(
        join(
          directory,
          stored.format === "current" ? "test-run.json" : "roll.json",
        ),
      ),
    });
    sources.push({
      id: sourceId,
      kind: "test-run",
      name: run.name,
      gitSha: stored.testRun.gitSha.toLowerCase(),
      createdAt: run.createdAt,
      asset: sourceAsset,
      outcome: run.outcome,
      ...(run.failure === undefined ? {} : { failure: run.failure }),
    });
    const evidenceIds: string[] = [];
    for (const [index, artifact] of run.artifacts.entries()) {
      const id = `${sourceId}-${index}`;
      const judgments =
        artifact.judgments.length > 0
          ? artifact.judgments
          : artifact.results.map(
              (result) =>
                ({
                  expectation: result.expectation,
                  state: result.passed ? "passed" : "failed",
                  reasoning: result.evidence,
                }) satisfies ReviewReport["evidence"][number]["judgments"][number],
            );
      if (artifact.fileName) {
        if (
          basename(artifact.fileName) !== artifact.fileName ||
          !artifact.fileName.endsWith(".png")
        )
          throw new Error("Invalid screenshot path.");
        evidence.push({
          id,
          sourceId,
          kind: "image",
          caption: artifact.caption,
          description: artifact.description,
          judgments,
          asset: await image(join(directory, artifact.fileName)),
        });
      } else {
        if (judgments.length === 0) continue;
        evidence.push({
          id,
          sourceId,
          kind: "assertion",
          caption: artifact.caption,
          judgments,
        });
      }
      evidenceIds.push(id);
    }
    sections.push({ id: sourceId, sourceId, title: run.name, evidenceIds });
  }
  for (const path of options.docShots ?? []) {
    const body = await regularFile(path);
    const shot = docShotReceiptSchema.parse(JSON.parse(body.toString("utf8")));
    const sourceId = `shot-${digest(`${shot.gitSha}:${shot.name}:${shot.createdAt}`)}`;
    if (sources.some((source) => source.id === sourceId)) continue;
    const sourceAsset = `${sourceId}.json`;
    assets.set(sourceAsset, { name: sourceAsset, body });
    sources.push({
      id: sourceId,
      kind: "docshot",
      name: shot.name,
      gitSha: shot.gitSha,
      createdAt: shot.createdAt,
      asset: sourceAsset,
    });
    const id = `${sourceId}-image`;
    evidence.push({
      id,
      sourceId,
      kind: "image",
      caption: shot.name,
      description: "Documentation reference",
      judgments: [],
      asset: await image(join(dirname(path), shot.fileName)),
    });
    sections.push({
      id: sourceId,
      sourceId,
      title: shot.name,
      evidenceIds: [id],
    });
  }
  const first = sources[0];
  if (!first) throw new Error("Select at least one test run or DocShot.");
  const report = reviewSchema.parse({
    schemaVersion: 1,
    title: options.title ?? "Change verification",
    gitSha: first.gitSha,
    createdAt: new Date().toISOString(),
    gaps: options.gaps ?? [],
    sources,
    sections,
    evidence,
  });
  return { report, assets: [...assets.values()] };
}

export function renderReviewComment(
  report: ReviewReport,
  url?: string,
): string {
  const summary = summarizeReview(report);
  const lines = [
    "<!-- test-evidence -->",
    `**${summary.verdict}** · ${summary.passedTests}/${summary.tests} tests · ${summary.passedAssertions}/${summary.assertions} assertions · ${summary.images} images`,
    "",
    `Commit \`${report.gitSha}\` · selected evidence`,
  ];
  if (url) lines.push("", `[Open review report](${url})`);
  if (report.gaps.length > 0)
    lines.push("", `Coverage gaps: ${report.gaps.join("; ")}`);
  if (summary.pendingVisual > 0)
    lines.push("", `${summary.pendingVisual} visual judgment(s) pending.`);
  return lines.join("\n");
}
