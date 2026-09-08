import { z } from "zod";

export const reportIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const assetNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(png|json)$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const judgment = z.object({
  expectation: z.string(),
  state: z.enum(["passed", "failed", "pending"]),
  reasoning: z.string(),
});
const source = z.object({
  id,
  name: z.string(),
  gitSha: sha,
  createdAt: z.iso.datetime(),
  asset: assetNameSchema,
});
const evidence = z.object({ id, sourceId: id, caption: z.string() });

export const reviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1),
    gitSha: sha,
    createdAt: z.iso.datetime(),
    gaps: z.array(z.string()),
    sources: z
      .array(
        z.discriminatedUnion("kind", [
          source.extend({
            kind: z.literal("test-run"),
            outcome: z.enum(["passed", "failed", "skipped", "unknown"]),
            failure: z.string().optional(),
          }),
          source.extend({ kind: z.literal("docshot") }),
        ]),
      )
      .min(1),
    sections: z
      .array(
        z.object({
          id,
          title: z.string(),
          sourceId: id,
          evidenceIds: z.array(id),
        }),
      )
      .min(1),
    evidence: z.array(
      z.discriminatedUnion("kind", [
        evidence.extend({
          kind: z.literal("assertion"),
          judgments: z.array(judgment).min(1),
        }),
        evidence.extend({
          kind: z.literal("image"),
          asset: assetNameSchema,
          description: z.string(),
          judgments: z.array(judgment),
        }),
      ]),
    ),
  })
  .superRefine((report, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const entries of [report.sources, report.sections, report.evidence]) {
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        fail("IDs must be unique within each collection.");
    }
    const sources = new Set(report.sources.map((entry) => entry.id));
    const evidenceIds = new Set(report.evidence.map((entry) => entry.id));
    if (report.sources.some((entry) => entry.gitSha !== report.gitSha))
      fail("Every source must match the report commit.");
    for (const entry of [...report.sections, ...report.evidence]) {
      if (!sources.has(entry.sourceId))
        fail(`Unknown source: ${entry.sourceId}`);
    }
    for (const section of report.sections) {
      if (section.evidenceIds.some((entry) => !evidenceIds.has(entry)))
        fail(`Unknown evidence in ${section.id}`);
    }
  });

export type ReviewReport = z.infer<typeof reviewSchema>;
export type ReviewEvidence = ReviewReport["evidence"][number];

export const docShotReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("docshot"),
  name: z.string(),
  gitSha: sha,
  createdAt: z.iso.datetime(),
  fileName: assetNameSchema,
});

/** No stored summary flags: all renderers use the same recorded facts. */
export function summarizeReview(
  report: Pick<ReviewReport, "sources" | "evidence" | "gaps">,
) {
  const tests = report.sources.filter((entry) => entry.kind === "test-run");
  const assertions = report.evidence
    .filter((entry) => entry.kind === "assertion")
    .flatMap((entry) => entry.judgments);
  const visual = report.evidence
    .filter((entry) => entry.kind === "image")
    .flatMap((entry) => entry.judgments);
  const judgments = [...assertions, ...visual];
  const failed =
    tests.some((entry) => entry.outcome === "failed") ||
    judgments.some((entry) => entry.state === "failed");
  const incomplete =
    tests.some((entry) => entry.outcome !== "passed") ||
    report.gaps.length > 0 ||
    judgments.some((entry) => entry.state === "pending") ||
    tests.some(
      (entry) =>
        !report.evidence.some(
          (item) => item.sourceId === entry.id && item.kind === "assertion",
        ),
    );
  const verdict = failed
    ? "Failed"
    : incomplete
      ? "Incomplete"
      : tests.length === 0
        ? "Reference"
        : "Passed";
  return {
    verdict,
    tests: tests.length,
    passedTests: tests.filter((entry) => entry.outcome === "passed").length,
    assertions: assertions.length,
    passedAssertions: assertions.filter((entry) => entry.state === "passed")
      .length,
    images: report.evidence.filter((entry) => entry.kind === "image").length,
    pendingVisual: visual.filter((entry) => entry.state === "pending").length,
  };
}
