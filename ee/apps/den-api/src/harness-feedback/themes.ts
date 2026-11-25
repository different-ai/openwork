import { HARNESS_FEEDBACK_THEMES } from "@openwork-ee/den-db/schema"
import { z } from "zod"

export const harnessFeedbackTheme = z.enum(HARNESS_FEEDBACK_THEMES)
export type HarnessFeedbackTheme = z.infer<typeof harnessFeedbackTheme>

export const HARNESS_FEEDBACK_THEME_LABELS: Record<HarnessFeedbackTheme, string> = {
  secrets: "Secrets and sign-in",
  browser: "Browser",
  computer_use: "Computer use",
  connections: "Connections",
  sessions: "Sessions",
  automations: "Automations",
  files: "Files and shell",
  skills: "Skills and instructions",
  artifacts: "Artifacts",
  app: "App and engine",
  other: "Other",
}
