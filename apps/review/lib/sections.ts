import { summarizeReview } from "@openwork/review";
import type { ReviewEvidence, ReviewReport } from "@openwork/review";

export type Verdict = ReturnType<typeof summarizeReview>["verdict"];
export type Judgment = ReviewEvidence["judgments"][number];
export type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;

export interface ReportSection {
  id: string;
  title: string;
  number: number;
  source: ReviewReport["sources"][number];
  verdict: Verdict;
  assertions: Judgment[];
  images: ImageEvidence[];
}

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

export function visualState(image: ImageEvidence): "failed" | "pending" | "passed" | null {
  if (!image.judgments.length) return null;
  if (image.judgments.some((judgment) => judgment.state === "failed")) return "failed";
  if (image.judgments.some((judgment) => judgment.state === "pending")) return "pending";
  return "passed";
}

export function designNotesLabel(image: ImageEvidence): string | null {
  const notes = image.designNotes ?? [];
  if (!notes.length) return null;
  const medium = notes.filter((note) => note.severity === "medium").length;
  return `${notes.length} design ${notes.length === 1 ? "note" : "notes"}${medium ? `, ${medium} worth fixing` : ""}`;
}
