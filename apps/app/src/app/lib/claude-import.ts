import { z } from "zod";

/** Responses of the openwork-server `/workspace/:id/claude-import/*` routes. */

export const claudeImportItemSchema = z.object({
  sourceId: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  messageCount: z.number(),
  status: z.enum(["new", "imported", "changed"]),
  sessionId: z.string(),
  notes: z.array(z.string()),
});

export const claudeImportItemsSchema = z.object({ items: z.array(claudeImportItemSchema) });

export const claudeImportResultSchema = z.object({
  sourceId: z.string(),
  sessionId: z.string(),
  status: z.enum(["imported", "already_imported", "skipped_changed", "failed"]),
  message: z.string().optional(),
});

export const claudeImportResultsSchema = z.object({ results: z.array(claudeImportResultSchema) });

export type ClaudeImportItem = z.infer<typeof claudeImportItemSchema>;
export type ClaudeImportResult = z.infer<typeof claudeImportResultSchema>;
