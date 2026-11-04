import { z } from "zod"

// Keep Google's property names on reads so callers can distinguish status events
// from ordinary events whose location happens to contain the same text.
export const workingLocationPropertiesSchema = z.object({
  type: z.enum(["homeOffice", "officeLocation", "customLocation"]),
  homeOffice: z.unknown().optional(),
  officeLocation: z.object({
    label: z.string().optional(), buildingId: z.string().optional(),
    floorId: z.string().optional(), floorSectionId: z.string().optional(), deskId: z.string().optional(),
  }).nullish(),
  customLocation: z.object({ label: z.string().optional() }).nullish(),
})

const label = z.string().trim().min(1).max(1_000)
export const setWorkingLocationBodySchema = z.object({
  from: z.string().date().describe("First all-day date, YYYY-MM-DD, inclusive."),
  to: z.string().date().refine((value) => value < "9999-12-31", "The exclusive end must fit in a four-digit year.").describe("Last all-day date, YYYY-MM-DD, inclusive. At most 31 days per call."),
  type: z.enum(["home", "office", "custom"]),
  customLabel: label.optional().describe("Required for custom, for example San Francisco."),
  officeLabel: label.optional(),
  buildingId: label.optional(),
  floorId: label.optional(),
  floorSectionId: label.optional(),
  deskId: label.optional(),
}).strict().superRefine((input, ctx) => {
  const days = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000 + 1
  if (days < 1 || days > 31) ctx.addIssue({ code: "custom", path: ["to"], message: "Use an inclusive range of 1–31 days; to must not precede from." })
  if (input.type === "custom" && !input.customLabel) ctx.addIssue({ code: "custom", path: ["customLabel"], message: "custom requires customLabel." })
  if (input.type !== "custom" && input.customLabel !== undefined) ctx.addIssue({ code: "custom", path: ["customLabel"], message: "customLabel is only for custom locations." })
  if (input.type !== "office" && [input.officeLabel, input.buildingId, input.floorId, input.floorSectionId, input.deskId].some((value) => value !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Office fields are only for office locations." })
  }
}).meta({ ref: "GoogleWorkspaceSetWorkingLocationBody" })

export function nextCalendarDate(date: string): string {
  return new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10)
}

export function workingLocationPayload(input: z.infer<typeof setWorkingLocationBodySchema>, date: string) {
  const workingLocationProperties = input.type === "home"
    ? { type: "homeOffice", homeOffice: {} }
    : input.type === "office"
      ? { type: "officeLocation", officeLocation: { label: input.officeLabel, buildingId: input.buildingId, floorId: input.floorId, floorSectionId: input.floorSectionId, deskId: input.deskId } }
      : { type: "customLocation", customLocation: { label: input.customLabel } }
  return {
    eventType: "workingLocation",
    summary: input.type === "home" ? "Home" : input.type === "office" ? input.officeLabel ?? "Office" : input.customLabel,
    start: { date }, end: { date: nextCalendarDate(date) },
    visibility: "public", transparency: "transparent", workingLocationProperties,
  }
}
