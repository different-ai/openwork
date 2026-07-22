import { validateProductionConfig } from "../../src/config"

export const dynamic = "force-dynamic"

export function GET(): Response {
  const missing = validateProductionConfig()
  return Response.json({
    service: "openwork-diagnostics",
    status: missing.length === 0 ? "ok" : "configuration_required",
    ...(missing.length === 0 ? {} : { missing }),
  }, { status: missing.length === 0 ? 200 : 503 })
}
