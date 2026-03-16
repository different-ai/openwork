import { z } from "zod"

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.string().optional(),
  DAYTONA_API_URL: z.string().optional(),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_OPENWORK_PORT: z.string().optional(),
  DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: z.string().optional(),
})

const parsed = EnvSchema.parse(process.env)

function optionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export const env = {
  databaseUrl: parsed.DATABASE_URL,
  port: Number(parsed.PORT ?? "8789"),
  daytona: {
    apiUrl: optionalString(parsed.DAYTONA_API_URL) ?? "https://app.daytona.io/api",
    apiKey: optionalString(parsed.DAYTONA_API_KEY),
    target: optionalString(parsed.DAYTONA_TARGET),
    openworkPort: Number(parsed.DAYTONA_OPENWORK_PORT ?? "8787"),
    signedPreviewExpiresSeconds: Number(parsed.DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS ?? "86400"),
  },
}
