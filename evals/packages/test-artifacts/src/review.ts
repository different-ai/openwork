import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  designReviewFileSchema,
  docShotReceiptSchema,
  reviewSchema,
  summarizeReview,
} from "@openwork/review";
import type { DesignNote as ReviewDesignNote, ReviewReport } from "@openwork/review";
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

/**
 * Advisory notes from `design-review.json`, keyed by screenshot file name.
 * A missing, malformed or other-commit file contributes nothing: design notes
 * must never block publishing the evidence itself.
 */
async function readDesignNotes(directory: string, gitSha: string): Promise<Record<string, ReviewDesignNote[]>> {
  try {
    const parsed = designReviewFileSchema.safeParse(JSON.parse((await regularFile(join(directory, "design-review.json"))).toString("utf8")));
    if (!parsed.success || (parsed.data.gitSha && parsed.data.gitSha.toLowerCase() !== gitSha.toLowerCase())) return {};
    return parsed.data.notes;
  } catch {
    return {};
  }
}

/** One design note as the PR's Evidence preview check lists it: the note plus where it was found. */
export interface DesignDigestNote extends ReviewDesignNote {
  spec: string | null;
  step: string;
}

/**
 * Every design note across the published runs, flattened for the PR. Same
 * rules as the report: a missing, malformed or other-commit file adds nothing.
 */
export async function designDigest(testRunDirs: string[]): Promise<{ reviewed: number; notes: DesignDigestNote[] }> {
  let reviewed = 0;
  const notes: DesignDigestNote[] = [];
  for (const directory of [...new Set(testRunDirs)]) {
    const stored = await readTestRunDirectory(directory);
    if (!stored?.testRun.gitSha) continue;
    try {
      const parsed = designReviewFileSchema.safeParse(JSON.parse((await regularFile(join(directory, "design-review.json"))).toString("utf8")));
      if (!parsed.success || (parsed.data.gitSha && parsed.data.gitSha.toLowerCase() !== stored.testRun.gitSha.toLowerCase())) continue;
      reviewed += 1;
      const captions = new Map(stored.testRun.artifacts.map((artifact) => [artifact.fileName, artifact.caption]));
      for (const [fileName, entries] of Object.entries(parsed.data.notes)) {
        const step = parsed.data.screens?.[fileName]?.caption ?? captions.get(fileName) ?? fileName;
        for (const note of entries) notes.push({ ...note, spec: parsed.data.specFile ?? stored.testRun.specFile ?? null, step });
      }
    } catch {
      // No design review for this run; publishing the evidence never depends on it.
    }
  }
  return { reviewed, notes };
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
    // IHDR is the first chunk: width and height follow the signature and chunk header.
    const width = body.length >= 24 ? body.readUInt32BE(16) : 0;
    const height = body.length >= 24 ? body.readUInt32BE(20) : 0;
    return { name, ...(width > 0 && height > 0 ? { size: { width, height } } : {}) };
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
    const designNotes = await readDesignNotes(directory, stored.testRun.gitSha);
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
        const stored = await image(join(directory, artifact.fileName));
        evidence.push({
          id,
          sourceId,
          kind: "image",
          caption: artifact.caption,
          description: artifact.description,
          judgments,
          asset: stored.name,
          ...(stored.size ? { size: stored.size } : {}),
          ...(artifact.checkpoint ? { checkpoint: artifact.checkpoint } : {}),
          ...(artifact.checkpointMatch ? { checkpointMatch: artifact.checkpointMatch } : {}),
          ...(artifact.checkpointError ? { checkpointError: artifact.checkpointError } : {}),
          ...(designNotes[artifact.fileName]?.length ? { designNotes: designNotes[artifact.fileName]?.slice(0, 20) } : {}),
          ...(artifact.step === undefined ? {} : { step: artifact.step }),
          ...(artifact.change ? { change: artifact.change } : {}),
          ...(artifact.focus ? { focus: artifact.focus } : {}),
          ...(artifact.settle ? { settled: artifact.settle.settled } : {}),
          ...(artifact.failure ? { failure: true } : {}),
        });
      } else {
        if (judgments.length === 0) continue;
        evidence.push({
          id,
          sourceId,
          kind: "assertion",
          caption: artifact.caption,
          judgments,
          ...(artifact.step === undefined ? {} : { step: artifact.step }),
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
      asset: (await image(join(dirname(path), shot.fileName))).name,
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
    title: options.title ?? "Selected evidence",
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
    `Selected evidence: **${summary.verdict}** · ${summary.passedTests}/${summary.tests} tests · ${summary.passedAssertions}/${summary.assertions} assertions · ${summary.images} images`,
    "",
    `Commit \`${report.gitSha}\` · selected evidence`,
    "Required verification is reported separately by the current-head Required verification check.",
  ];
  if (url) lines.push("", `[Open review report](${url})`);
  if (report.gaps.length > 0)
    lines.push("", `Coverage gaps: ${report.gaps.join("; ")}`);
  if (summary.pendingVisual > 0)
    lines.push("", `${summary.pendingVisual} visual judgment(s) pending.`);
  const designNotes = report.evidence.flatMap((item) => item.kind === "image" ? item.designNotes ?? [] : []);
  if (designNotes.length > 0) {
    const medium = designNotes.filter((note) => note.severity === "medium").length;
    lines.push("", `Design review (advisory): ${designNotes.length} note(s), ${medium} worth fixing before merge.`);
  }
  return lines.join("\n");
}
