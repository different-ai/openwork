import { z } from "zod"

// Typed contribution registration.
//
// A contribution is a declaration that an app wants to appear somewhere in the
// host. It never carries behaviour: the host reads the declaration, decides
// whether the app is currently allowed to occupy that place, and renders it.
// Every contribution is withdrawn the moment the app is disabled, uninstalled,
// quarantined, or has the backing permission revoked.

/** Contribution ids are namespaced under their app id, so two apps cannot collide. */
export const contributionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, "contribution id must be lowercase, dot or dash separated")

const label = z.string().min(1).max(48)
const description = z.string().min(1).max(280)

/** Relative path inside the package, used for icons and other bundled assets. */
export const packagePathSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "path must be relative, forward-slashed, and free of . or .. segments")
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "path must not contain . or .. segments",
  )

export const surfacePresentationSchema = z.enum(["panel", "floating"])
export type SurfacePresentation = z.infer<typeof surfacePresentationSchema>

const surfaceSize = z
  .object({
    width: z.int().min(120).max(2000),
    height: z.int().min(80).max(2000),
  })
  .strict()

/**
 * Where the host may place a floating surface. The app picks a preset; the host
 * owns the actual geometry, display selection, and safe-area clamping, so an
 * app can never place a window off-screen or over a system surface.
 */
export const surfaceAnchorSchema = z.enum([
  "right-center",
  "right-top",
  "right-bottom",
  "left-center",
  "top-center",
  "bottom-center",
])
export type SurfaceAnchor = z.infer<typeof surfaceAnchorSchema>

export const settingKindSchema = z.enum(["boolean", "string", "select"])

const settingContribution = z.discriminatedUnion("kind", [
  z.object({
    type: z.literal("setting"),
    kind: z.literal("boolean"),
    id: contributionIdSchema,
    label,
    description: description.optional(),
    default: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("setting"),
    kind: z.literal("string"),
    id: contributionIdSchema,
    label,
    description: description.optional(),
    default: z.string().max(256),
    max_length: z.int().min(1).max(2048).optional(),
  }).strict(),
  z.object({
    type: z.literal("setting"),
    kind: z.literal("select"),
    id: contributionIdSchema,
    label,
    description: description.optional(),
    options: z
      .array(z.object({ value: z.string().min(1).max(64), label }).strict())
      .min(2)
      .max(24),
    default: z.string().min(1).max(64),
  }).strict(),
])

export const appContributionSchema = z.union([
  z.object({
    type: z.literal("surface"),
    id: contributionIdSchema,
    /** Key into `entrypoints.surfaces`. Validation requires the key to exist. */
    entrypoint: z.string().min(1).max(64),
    presentation: surfacePresentationSchema,
    default_size: surfaceSize,
    min_size: surfaceSize.optional(),
    anchor: surfaceAnchorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("right_sidebar_item"),
    id: contributionIdSchema,
    label,
    /** Contribution id of a `surface` this item activates. */
    surface: contributionIdSchema,
    icon: packagePathSchema,
    tooltip: description.optional(),
    /** Lower sorts earlier. Ties break on app id then contribution id, so ordering is deterministic. */
    order: z.int().min(0).max(10_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("command"),
    id: contributionIdSchema,
    title: label,
    description: description.optional(),
  }).strict(),
  z.object({
    type: z.literal("shortcut"),
    id: contributionIdSchema,
    /** Contribution id of a `command` this shortcut invokes. */
    command: contributionIdSchema,
    /**
     * Declared here for review; the actual registration is gated by the
     * `desktop.globalShortcut` permission naming the same shortcut id.
     */
    global: z.boolean().default(false),
  }).strict(),
  settingContribution,
  z.object({
    type: z.literal("background"),
    id: contributionIdSchema,
    /** Must be `"background"`; the path lives in `entrypoints.background`. */
    entrypoint: z.literal("background"),
  }).strict(),
  z.object({
    type: z.literal("status"),
    id: contributionIdSchema,
    /** Contribution id of the `right_sidebar_item` this status decorates. */
    target: contributionIdSchema,
    /** `badge` shows a count, `dot` shows presence, `text` shows a short string. */
    display: z.enum(["badge", "dot", "text"]),
  }).strict(),
])

export type AppContribution = z.infer<typeof appContributionSchema>
export type AppContributionType = AppContribution["type"]

export const APP_CONTRIBUTION_TYPES = [
  "surface",
  "right_sidebar_item",
  "command",
  "shortcut",
  "setting",
  "background",
  "status",
] as const satisfies readonly AppContributionType[]

export function contributionsOfType<T extends AppContributionType>(
  contributions: readonly AppContribution[],
  type: T,
): Extract<AppContribution, { type: T }>[] {
  return contributions.filter(
    (contribution): contribution is Extract<AppContribution, { type: T }> => contribution.type === type,
  )
}

/**
 * Fully-qualified id for a registered contribution.
 *
 * Registration keys are always `<appId>/<contributionId>`. Two apps that both
 * contribute `main` stay distinct, and an app can never claim a built-in slot.
 */
export function qualifiedContributionId(appId: string, contributionId: string): string {
  return `${appId}/${contributionId}`
}
