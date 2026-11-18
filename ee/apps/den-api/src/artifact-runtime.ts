import { z } from "zod"

export const artifactRunInputSchema = z.object({
  timeZone: z.string().min(1).max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value })
      return true
    } catch {
      return false
    }
  }, "Expected an IANA time zone").optional(),
}).strict()

export function artifactRuntime(timeZone = "UTC", now = new Date()) {
  artifactRunInputSchema.parse({ timeZone })
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  })
  const dateAt = (instant: number) => {
    const parts = formatter.formatToParts(instant)
    return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-")
  }
  const today = dateAt(now.getTime())
  const boundary = (date: string) => {
    let low = Date.parse(date + "T00:00:00Z") - 36 * 60 * 60_000
    let high = low + 72 * 60 * 60_000
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (dateAt(middle) < date) low = middle
      else high = middle
    }
    return new Date(high).toISOString()
  }
  const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 24 * 60 * 60_000).toISOString().slice(0, 10)
  return { now: now.toISOString(), today, timeZone, dayStart: boundary(today), dayEnd: boundary(tomorrow) }
}
