import { z } from "zod"

const portEnvSchema = z.coerce.number().int().min(1).max(65_535)
const secondsEnvSchema = z.coerce.number().int().min(1).max(31_536_000)

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_HOST: z.string().min(1).optional(),
  DATABASE_USERNAME: z.string().min(1).optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DB_MODE: z.enum(["mysql", "planetscale"]).optional(),
  PORT: portEnvSchema.default(8789),
  DEN_MARKETING_URL: z.string().optional(),
  DAYTONA_API_URL: z.string().optional(),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_OPENWORK_PORT: portEnvSchema.default(8787),
  DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: secondsEnvSchema.default(86_400),
}).superRefine((value, ctx) => {
  const inferredMode = value.DB_MODE ?? (value.DATABASE_URL ? "mysql" : "planetscale")

  if (inferredMode === "mysql" && !value.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "DATABASE_URL is required when using mysql mode",
      path: ["DATABASE_URL"],
    })
  }

  if (inferredMode === "planetscale") {
    for (const key of ["DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD"] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when using planetscale mode`,
          path: [key],
        })
      }
    }
  }
})

const parsed = EnvSchema.parse(process.env)

const planetscaleCredentials =
  parsed.DATABASE_HOST && parsed.DATABASE_USERNAME && parsed.DATABASE_PASSWORD !== undefined
    ? {
        host: parsed.DATABASE_HOST,
        username: parsed.DATABASE_USERNAME,
        password: parsed.DATABASE_PASSWORD,
      }
    : null

function optionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export const env = {
  databaseUrl: parsed.DATABASE_URL,
  dbMode: parsed.DB_MODE ?? (parsed.DATABASE_URL ? "mysql" : "planetscale"),
  planetscale: planetscaleCredentials,
  port: parsed.PORT,
  marketingUrl: optionalString(parsed.DEN_MARKETING_URL),
  daytona: {
    apiUrl: optionalString(parsed.DAYTONA_API_URL) ?? "https://app.daytona.io/api",
    apiKey: optionalString(parsed.DAYTONA_API_KEY),
    target: optionalString(parsed.DAYTONA_TARGET),
    openworkPort: parsed.DAYTONA_OPENWORK_PORT,
    signedPreviewExpiresSeconds: parsed.DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS,
  },
}
