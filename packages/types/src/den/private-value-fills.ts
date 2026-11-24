import { z } from "zod";

export const PRIVATE_VALUE_FILL_RESULTS = ["filled", "declined", "refused"] as const;
export const PRIVATE_VALUE_FILL_SOURCES = ["command", "paste", "kept"] as const;

/**
 * One field the desktop filled, or would have filled, with a private value, as it reports it to the
 * organization's audit log. Never the value: the site, the field, where the value came from, the program
 * that printed it and what happened.
 */
export const privateValueFillReportSchema = z.object({
  id: z.string().min(8).max(100),
  at: z.string().datetime(),
  site: z.string().min(1).max(500),
  field: z.string().min(1).max(200),
  source: z.enum(PRIVATE_VALUE_FILL_SOURCES),
  program: z.string().min(1).max(200).optional(),
  result: z.enum(PRIVATE_VALUE_FILL_RESULTS),
});

export type PrivateValueFillReport = z.infer<typeof privateValueFillReportSchema>;

export const privateValueFillReportResponseSchema = z.object({ recorded: z.boolean() });

export type PrivateValueFillReportResponse = z.infer<typeof privateValueFillReportResponseSchema>;

export const PRIVATE_VALUE_FILLS_ROUTE = "/v1/me/private-value-fills";
