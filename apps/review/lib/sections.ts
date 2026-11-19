import { summarizeReview } from "@openwork/review";
import type { ReviewEvidence, ReviewReport } from "@openwork/review";

export type Verdict = ReturnType<typeof summarizeReview>["verdict"];
export type Judgment = ReviewEvidence["judgments"][number];
export type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;

export interface ReportSection {
  id: string;
  title: string;
  /** 1-based position in the report; stays stable while a filter hides other sections. */
  number: number;
  source: ReviewReport["sources"][number];
  verdict: Verdict;
  assertions: Judgment[];
  images: ImageEvidence[];
}

/** Sections in report order with their source, evidence and verdict. Sections whose source is missing are dropped. */
export function composeSections(report: ReviewReport): ReportSection[] {
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]));
  return report.sections.flatMap((section) => {
    const source = report.sources.find((item) => item.id === section.sourceId);
    if (!source) return [];
    const items = section.evidenceIds.flatMap((key) => evidenceById.get(key) ?? []);
    return [{
      id: section.id,
      title: section.title,
      source,
      verdict: summarizeReview({ sources: [source], evidence: items, gaps: [] }).verdict,
      assertions: items.filter((item) => item.kind === "assertion").flatMap((item) => item.judgments),
      images: items.filter((item): item is ImageEvidence => item.kind === "image"),
    }];
  }).map((section, index) => ({ ...section, number: index + 1 }));
}

/** The worst visual judgment on a screenshot, or null when none was recorded. */
export function visualState(image: ImageEvidence): "failed" | "pending" | "passed" | null {
  if (!image.judgments.length) return null;
  if (image.judgments.some((judgment) => judgment.state === "failed")) return "failed";
  if (image.judgments.some((judgment) => judgment.state === "pending")) return "pending";
  return "passed";
}

/** "2 design notes, 1 worth fixing", or null when the screenshot has none. */
export function designNotesLabel(image: ImageEvidence): string | null {
  const notes = image.designNotes ?? [];
  if (!notes.length) return null;
  const medium = notes.filter((note) => note.severity === "medium").length;
  return `${notes.length} design ${notes.length === 1 ? "note" : "notes"}${medium ? `, ${medium} worth fixing` : ""}`;
}
