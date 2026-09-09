import { z } from "zod";

// A bounded, declarative mockup: all content renders as text, never HTML or code.
const text = z.string().trim().min(1).max(500);
const blockSchema = z.object({
  kind: z.enum(["text", "metric", "field", "button", "list", "image"]),
  label: text,
  value: z.string().max(2000).optional(),
  items: z.array(text).max(12).optional(),
});

export const visualizationSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .describe("Stable design id; reuse for revisions."),
  title: text,
  revision: z.number().int().min(1).max(9999),
  description: z.string().max(1000).optional(),
  navigation: z.array(text).max(8).optional(),
  sections: z
    .array(
      z.object({
        title: text,
        columns: z.enum(["one", "two", "three"]).default("one"),
        blocks: z.array(blockSchema).min(1).max(12),
      }),
    )
    .min(1)
    .max(8),
});

export type Visualization = z.infer<typeof visualizationSchema>;
