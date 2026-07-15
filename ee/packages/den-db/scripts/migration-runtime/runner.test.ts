import { afterEach, describe, expect, test } from "bun:test"
import { ExitCode, MigrationFailure, parseConfig, parseManifest, splitStatements } from "./runner"

const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_HOST",
  "DATABASE_USERNAME",
  "DATABASE_PASSWORD",
  "DB_MODE",
  "MIGRATION_CONNECT_TIMEOUT_MS",
  "MIGRATION_LOCK_TIMEOUT_SECONDS",
  "MIGRATION_LOCK_LEASE_SECONDS",
]

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe("immutable migration runner configuration", () => {
  test("accepts MySQL compatibility-check mode with bounded lock settings", () => {
    process.env.DB_MODE = "mysql"
    process.env.DATABASE_URL = "mysql://openwork:secret@db.internal:3306/openwork"
    process.env.MIGRATION_LOCK_TIMEOUT_SECONDS = "45"
    process.env.MIGRATION_LOCK_LEASE_SECONDS = "600"

    const config = parseConfig(["--check"])

    expect(config.mode).toBe("check")
    expect(config.databaseMode).toBe("mysql")
    expect(config.lockTimeoutSeconds).toBe(45)
    expect(config.lockLeaseSeconds).toBe(600)
  })

  test("classifies missing connection configuration", () => {
    delete process.env.DB_MODE
    delete process.env.DATABASE_URL
    delete process.env.DATABASE_HOST
    delete process.env.DATABASE_USERNAME

    try {
      parseConfig([])
      throw new Error("Expected parseConfig to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationFailure)
      if (error instanceof MigrationFailure) {
        expect(error.category).toBe("configuration_invalid")
        expect(error.exitCode).toBe(ExitCode.ConfigurationInvalid)
      }
    }
  })
})

describe("immutable migration manifest", () => {
  test("rejects a schema version that is not the final migration", () => {
    const manifest = {
      formatVersion: 1,
      dialect: "mysql",
      schemaVersion: "0002_second",
      journalVersion: "7",
      bootstrap: {
        file: "sql/bootstrap.sql",
        sha256: "bootstrap-hash",
        tables: ["user"],
        indexes: [],
      },
      requiredIndexes: [],
      migrations: [
        {
          idx: 1,
          createdAt: 1,
          tag: "0001_first",
          file: "sql/0001_first.sql",
          sha256: "migration-hash",
        },
      ],
    }

    expect(() => parseManifest(manifest)).toThrow("schemaVersion")
  })
})

describe("immutable SQL execution", () => {
  test("splits older multi-statement migrations without Drizzle breakpoints", () => {
    const statements = splitStatements(`
      -- a semicolon in a comment; must not split
      UPDATE \`organization\` SET \`metadata\` = JSON_SET(\`metadata\`, '$.note', 'one;two');
      ALTER TABLE \`organization\` MODIFY COLUMN \`metadata\` json NULL;
    `)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("UPDATE")
    expect(statements[1]).toContain("ALTER TABLE")
  })
})
