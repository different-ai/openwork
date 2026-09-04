import { beforeAll, expect, test } from "bun:test"
import { createAutomationSchema } from "@openwork/types/automations"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type ServiceModule = typeof import("../src/automations/service.js")
let AutomationService: ServiceModule["AutomationService"]

beforeAll(async () => {
  seedRequiredEnv()
  ;({ AutomationService } = await import("../src/automations/service.js"))
})

test("Cloud Automation creation fails before runtime or persistence without Web access", async () => {
  const service = new AutomationService({
    getOpenWorkWebAccess: async () => ({ hasAccess: false }),
  })
  const definition = createAutomationSchema.parse({
    name: "Daily summary",
    schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    action: {
      kind: "agent",
      instructions: "Summarize yesterday's work.",
      model: { providerId: "opencode", modelId: "big-pickle" },
    },
    executionTarget: "cloud",
  })

  await expect(service.create({
    organizationId: "organization_test",
    ownerMemberId: "member_test",
    modelAttentionCapable: true,
  }, definition)).rejects.toMatchObject({
    name: "OpenWorkWebAccessRequiredError",
    code: "openwork_web_access_required",
  })
})
