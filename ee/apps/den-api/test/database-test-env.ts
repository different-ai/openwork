// Shared by tests that write to a real MySQL database (run via `pnpm test:db`).
// Fails fast with a clear message instead of defaulting to a database that
// does not exist and surfacing as a connection error later.
export function seedDatabaseTestEnv(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error(
      [
        "DATABASE_URL is required: this test writes to a real MySQL database.",
        "Bootstrap one with: DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_test_den_api pnpm --dir ee/packages/den-db db:bootstrap",
        "then run: DATABASE_URL=<same url> pnpm --filter @openwork-ee/den-api test:db",
      ].join("\n"),
    )
  }
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  return databaseUrl
}
