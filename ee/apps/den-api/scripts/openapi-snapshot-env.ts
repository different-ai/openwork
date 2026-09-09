// Environment for exporting the published OpenAPI snapshot. Importing the Hono
// app only needs env validation to pass; the export never reads the database
// or serves traffic.

// `servers[0].url` in the exported document derives from this value. The
// published contract must name the hosted API on every machine, so the export
// overrides whatever the developer's shell or .env configured for local runs.
// The API's runtime configuration is untouched: this only applies to the
// exporter process.
export const publishedApiOrigin = "https://api.openworklabs.com"

const snapshotEnvDefaults: Record<string, string> = {
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
  DEN_AUTOMATIONS_ENABLED: "true",
  DEN_AUTOMATIONS_RUNTIME_ENABLED: "true",
}

export function seedSnapshotEnv(env: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(snapshotEnvDefaults)) {
    if (!env[name]?.trim()) {
      env[name] = value
    }
  }
  env.DEN_API_PUBLIC_URL = publishedApiOrigin
}
