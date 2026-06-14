import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let adminTools: typeof import("../src/mcp/admin-tools.js")

beforeAll(async () => {
  seedRequiredEnv()
  adminTools = await import("../src/mcp/admin-tools.js")
})

describe("assertReadOnlySql", () => {
  test("allows read statements and strips trailing semicolons", () => {
    expect(adminTools.assertReadOnlySql("SELECT 1;")).toBe("SELECT 1")
    expect(adminTools.assertReadOnlySql("  explain select id from user  ")).toBe("explain select id from user")
    expect(adminTools.assertReadOnlySql("SHOW TABLES")).toBe("SHOW TABLES")
    expect(adminTools.assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(
      "WITH x AS (SELECT 1) SELECT * FROM x",
    )
  })

  test("rejects writes", () => {
    expect(() => adminTools.assertReadOnlySql("DELETE FROM user")).toThrow()
    expect(() => adminTools.assertReadOnlySql("UPDATE user SET name = 'x'")).toThrow()
    expect(() => adminTools.assertReadOnlySql("INSERT INTO user VALUES (1)")).toThrow()
    expect(() => adminTools.assertReadOnlySql("DROP TABLE user")).toThrow()
  })

  test("rejects multiple statements", () => {
    expect(() => adminTools.assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(
      "Only a single SQL statement is allowed",
    )
  })

  test("rejects forbidden keywords smuggled into read statements", () => {
    expect(() => adminTools.assertReadOnlySql("SELECT * FROM user FOR UPDATE")).toThrow()
    expect(() => adminTools.assertReadOnlySql("SELECT 1 INTO OUTFILE '/tmp/x'")).toThrow()
    expect(() => adminTools.assertReadOnlySql("WITH x AS (SELECT 1) DELETE FROM user")).toThrow()
  })
})

describe("applyDefaultRowLimit", () => {
  test("appends the default limit to bare SELECTs", () => {
    expect(adminTools.applyDefaultRowLimit("SELECT id FROM user")).toEqual({
      sql: "SELECT id FROM user LIMIT 200",
      cap: 200,
    })
  })

  test("keeps an explicit LIMIT untouched", () => {
    expect(adminTools.applyDefaultRowLimit("SELECT id FROM user LIMIT 5").sql).toBe(
      "SELECT id FROM user LIMIT 5",
    )
  })

  test("clamps the requested limit to the max row cap", () => {
    expect(adminTools.applyDefaultRowLimit("SELECT id FROM user", 50_000)).toEqual({
      sql: "SELECT id FROM user LIMIT 1000",
      cap: 1000,
    })
  })

  test("does not append LIMIT to SHOW/DESCRIBE statements", () => {
    expect(adminTools.applyDefaultRowLimit("SHOW TABLES").sql).toBe("SHOW TABLES")
  })
})

describe("normalizeRows", () => {
  test("handles mysql2 [rows, fields] tuples", () => {
    const rows = [{ id: 1 }, { id: 2 }]
    expect(adminTools.normalizeRows([rows, [{ name: "id" }]])).toEqual(rows)
    expect(adminTools.normalizeRows([[], []])).toEqual([])
  })

  test("handles PlanetScale { rows } payloads", () => {
    const rows = [{ id: 1 }]
    expect(adminTools.normalizeRows({ rows })).toEqual(rows)
  })

  test("returns empty for unknown shapes", () => {
    expect(adminTools.normalizeRows(null)).toEqual([])
    expect(adminTools.normalizeRows({ insertId: 3 })).toEqual([])
  })
})

describe("buildAdminMcpVersionInfo", () => {
  test("reports toolset and den-api versions for deploy verification", () => {
    const info = adminTools.buildAdminMcpVersionInfo()
    expect(info.name).toBe("den-admin")
    expect(info.transport).toBe("streamable-http")
    expect(info.toolsetVersion).toBe(adminTools.DEN_ADMIN_MCP_VERSION)
    expect(info.toolsetVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(typeof info.denApi.latestAppVersion).toBe("string")
    expect(typeof info.denApi.minAppVersion).toBe("string")
    expect(info.node).toBe(process.version)
    expect(Date.parse(info.serverStartedAt)).not.toBeNaN()
  })
})
