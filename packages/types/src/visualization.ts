import { z } from "zod";

// A bounded, declarative mockup: all content renders as text, never HTML or code.
export const VISUALIZATION_LIMITS = {
  text: 500,
  value: 2000,
  description: 1000,
  navigation: 10,
  sections: 12,
  blocks: 16,
  items: 24,
} as const;

const text = z.string().trim().min(1).max(VISUALIZATION_LIMITS.text);

export const visualizationBlockKinds = [
  "text",
  "metric",
  "field",
  "button",
  "list",
  "image",
  "toggle",
  "select",
  "segmented",
  "chips",
  "table",
] as const;

export const visualizationTones = ["default", "primary", "destructive", "muted"] as const;

const blockSchema = z.object({
  kind: z
    .enum(visualizationBlockKinds)
    .describe(
      "text: heading + paragraph. metric: big number. field: input with placeholder. button: action. list: rows. image: placeholder. toggle: on/off switch (value 'On' or 'Off'). select: dropdown (items = options, value = selected). segmented: tab-like control (items = options, value = selected). chips: tags or status badges (items). table: rows as items using ' | ' between cells; the first item is the header row.",
    ),
  label: text,
  value: z.string().max(VISUALIZATION_LIMITS.value).optional(),
  items: z.array(text).max(VISUALIZATION_LIMITS.items).optional(),
  tone: z
    .enum(visualizationTones)
    .optional()
    .describe("Visual emphasis for button and chips blocks."),
  hint: z
    .string()
    .max(VISUALIZATION_LIMITS.text)
    .optional()
    .describe("Small helper text shown under the block."),
});

const sectionSchema = z.object({
  title: text,
  description: z.string().max(VISUALIZATION_LIMITS.description).optional(),
  columns: z.enum(["one", "two", "three"]).default("one"),
  nav: text
    .optional()
    .describe(
      "Navigation item this section belongs to. Sections without nav show on every page; when at least one section names a nav item, the navigation becomes clickable pages.",
    ),
  blocks: z.array(blockSchema).min(1).max(VISUALIZATION_LIMITS.blocks),
});

export const visualizationSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .describe("Stable design id; reuse for revisions."),
  title: text,
  revision: z.number().int().min(1).max(9999),
  description: z.string().max(VISUALIZATION_LIMITS.description).optional(),
  navigation: z.array(text).max(VISUALIZATION_LIMITS.navigation).optional(),
  sections: z.array(sectionSchema).min(1).max(VISUALIZATION_LIMITS.sections),
});

export type Visualization = z.infer<typeof visualizationSchema>;
export type VisualizationSection = Visualization["sections"][number];
export type VisualizationBlock = VisualizationSection["blocks"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown, max: number): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function toItems(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => toText(item, VISUALIZATION_LIMITS.text))
    .filter((item): item is string => item !== undefined);
  return items.length ? items : undefined;
}

function normalizeBlock(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : input.kind;
  const label =
    toText(input.label, VISUALIZATION_LIMITS.text) ??
    toText(input.title, VISUALIZATION_LIMITS.text) ??
    toText(input.name, VISUALIZATION_LIMITS.text);
  const rawValue = toText(input.value, VISUALIZATION_LIMITS.value);
  // A block with only a value still renders: promote the value to its label.
  const value = label === undefined ? undefined : rawValue;
  const items = toItems(input.items) ?? toItems(input.options) ?? toItems(input.rows);
  const tone = typeof input.tone === "string" ? input.tone.trim().toLowerCase() : undefined;
  const hint = toText(input.hint, VISUALIZATION_LIMITS.text);
  return {
    kind,
    label: label ?? (rawValue ? toText(rawValue, 120) : undefined),
    ...(value !== undefined ? { value } : {}),
    ...(items ? { items } : {}),
    ...(tone ? { tone } : {}),
    ...(hint ? { hint } : {}),
  };
}

function normalizeSection(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const columns =
    typeof input.columns === "string"
      ? input.columns.trim().toLowerCase()
      : input.columns === 2
        ? "two"
        : input.columns === 3
          ? "three"
          : input.columns === 1
            ? "one"
            : undefined;
  const blocks = Array.isArray(input.blocks)
    ? input.blocks.map(normalizeBlock).filter((block) => isRecord(block) && block.label !== undefined)
    : input.blocks;
  const description = toText(input.description, VISUALIZATION_LIMITS.description);
  const nav = toText(input.nav ?? input.page ?? input.tab, VISUALIZATION_LIMITS.text);
  return {
    title: toText(input.title, VISUALIZATION_LIMITS.text) ?? toText(input.name, VISUALIZATION_LIMITS.text),
    ...(description ? { description } : {}),
    ...(columns ? { columns } : {}),
    ...(nav ? { nav } : {}),
    blocks,
  };
}

/**
 * Lenient pre-pass that repairs the mistakes models make most often (untrimmed
 * strings, numbers instead of strings, empty items, synonyms like `options`)
 * before strict validation. Structural problems still fail validation.
 */
export function normalizeVisualizationInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const revision =
    typeof input.revision === "string" && /^\d+$/.test(input.revision.trim())
      ? Number(input.revision.trim())
      : input.revision;
  const description = toText(input.description, VISUALIZATION_LIMITS.description);
  const navigation = toItems(input.navigation ?? input.nav ?? input.tabs);
  return {
    id: typeof input.id === "string" ? input.id.trim() : input.id,
    title: toText(input.title, VISUALIZATION_LIMITS.text),
    revision: revision ?? 1,
    ...(description ? { description } : {}),
    ...(navigation ? { navigation } : {}),
    sections: Array.isArray(input.sections) ? input.sections.map(normalizeSection) : input.sections,
  };
}

export type VisualizationParseResult =
  | { ok: true; data: Visualization }
  | { ok: false; message: string };

/** Normalize then validate; on failure, return one readable message the model can act on. */
export function parseVisualization(input: unknown): VisualizationParseResult {
  const parsed = visualizationSchema.safeParse(normalizeVisualizationInput(input));
  if (parsed.success) return { ok: true, data: parsed.data };
  const lines = parsed.error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "design";
    return `- ${path}: ${issue.message}`;
  });
  const limits = `Limits: up to ${VISUALIZATION_LIMITS.sections} sections, ${VISUALIZATION_LIMITS.blocks} blocks per section, ${VISUALIZATION_LIMITS.items} items per block, ${VISUALIZATION_LIMITS.navigation} navigation items; block kinds: ${visualizationBlockKinds.join(", ")}.`;
  return {
    ok: false,
    message: `Visualization rejected. Fix these and call openwork_visualization again with the complete design:\n${lines.join("\n")}\n${limits} Split a large inventory into several mockups if needed.`,
  };
}
