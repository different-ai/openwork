const denWebPort = process.env.DEN_WEB_PORT?.trim() || "3005"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET ??= "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL ??= `http://localhost:${denWebPort}`

await import("./seed-demo-org.ts")
