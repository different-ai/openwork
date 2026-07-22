import { z } from "zod"

const loopbackHostSchema = z.enum(["127.0.0.1", "::1"])

const environmentSchema = z.object({
  ENTERPRISE_MOCK_LAB_ADMIN_SECRET: z
    .string()
    .min(32, "ENTERPRISE_MOCK_LAB_ADMIN_SECRET must contain at least 32 characters"),
  ENTERPRISE_MOCK_LAB_HOST: loopbackHostSchema.default("127.0.0.1"),
  ENTERPRISE_MOCK_LAB_PORT: z.coerce.number().int().min(1).max(65_535).default(8794),
  ENTERPRISE_MOCK_LAB_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
})

export type EnterpriseMockLabEnv = z.infer<typeof environmentSchema>

export function parseEnterpriseMockLabEnv(input: NodeJS.ProcessEnv): EnterpriseMockLabEnv {
  return environmentSchema.parse(input)
}

export function controlPlaneOrigin(env: Pick<EnterpriseMockLabEnv, "ENTERPRISE_MOCK_LAB_HOST" | "ENTERPRISE_MOCK_LAB_PORT">): string {
  const host = env.ENTERPRISE_MOCK_LAB_HOST === "::1" ? "[::1]" : env.ENTERPRISE_MOCK_LAB_HOST
  return `http://${host}:${env.ENTERPRISE_MOCK_LAB_PORT}`
}
