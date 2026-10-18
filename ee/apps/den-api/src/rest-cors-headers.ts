import { AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER } from "@openwork/types/automations"

/** Request headers accepted by the authenticated REST surface, never an origin or authorization grant. */
export const denRestCorsHeaders: readonly string[] = [
  "Content-Type",
  "Authorization",
  "X-Api-Key",
  "X-Request-Id",
  "X-OpenWork-Legacy-Org-Id",
  "X-OpenWork-Org-Id",
  "X-OpenWork-Audit-Correlation",
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
]
