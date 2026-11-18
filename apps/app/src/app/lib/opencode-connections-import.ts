import { z } from "zod";

/** Responses of the openwork-server `/workspace/:id/opencode-import/connections` routes. */

export const opencodeConnectionPreviewItemSchema = z.object({
  name: z.string(),
  kind: z.enum(["local", "remote"]).optional(),
  target: z.string().optional(),
  status: z.enum(["new", "already_present", "invalid", "blocked"]),
  reason: z.string().optional(),
});

export const opencodeConnectionsPreviewSchema = z.object({
  source: z.enum(["found", "missing", "invalid", "unreadable"]),
  items: z.array(opencodeConnectionPreviewItemSchema),
});

export const opencodeConnectionImportResultSchema = z.object({
  name: z.string(),
  status: z.enum(["imported", "already_present", "invalid", "blocked", "failed"]),
  message: z.string().optional(),
});

export const opencodeConnectionImportResultsSchema = z.object({ results: z.array(opencodeConnectionImportResultSchema) });

export type OpencodeConnectionPreviewItem = z.infer<typeof opencodeConnectionPreviewItemSchema>;
export type OpencodeConnectionsPreview = z.infer<typeof opencodeConnectionsPreviewSchema>;
export type OpencodeConnectionImportResult = z.infer<typeof opencodeConnectionImportResultSchema>;
