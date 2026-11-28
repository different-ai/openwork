import { z } from "zod";

export const artifactStorageSummarySchema = z.object({
  rowCount: z.number(),
  sizeBytes: z.number(),
  updatedAt: z.string().nullable(),
  collections: z.array(z.object({ name: z.string() })),
});

type Summary = z.infer<typeof artifactStorageSummarySchema>;

export function artifactStorageRowState(summary: Summary | null | undefined, failed: boolean) {
  if (!summary?.updatedAt) {
    return failed ? { kind: "unavailable" } as const : { kind: "hidden" } as const;
  }
  return { kind: "saved", rowCount: summary.rowCount, sizeBytes: summary.sizeBytes, collections: summary.collections.map(({ name }) => name) } as const;
}
