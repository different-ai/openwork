import { describe, expect, test } from "bun:test"

import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

describe("parseMySqlConnectionConfig", () => {
  test("parses a basic TCP connection URL", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@127.0.0.1:3306/openwork_den",
    )
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      password: "password",
      database: "openwork_den",
    })
  })

  test("defaults the port to 3306 when missing", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@db.internal/openwork_den",
    )
    expect(config.port).toBe(3306)
  })

  test("decodes percent-encoded username and password", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://us%40er:p%40ss%2Fword@host/db",
    )
    expect(config.user).toBe("us@er")
    expect(config.password).toBe("p@ss/word")
  })

  test("populates socketPath from ?socketPath query parameter (Cloud SQL)", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@localhost/openwork_den?socketPath=/cloudsql/project:region:instance",
    )
    expect(config.socketPath).toBe("/cloudsql/project:region:instance")
    // host/port still present; mysql2 ignores them when socketPath is set.
    expect(config.host).toBe("localhost")
    expect(config.port).toBe(3306)
  })

  test("accepts the ?socket alias", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@localhost/openwork_den?socket=/var/run/mysqld/mysqld.sock",
    )
    expect(config.socketPath).toBe("/var/run/mysqld/mysqld.sock")
  })

  test("prefers ?socketPath over ?socket when both are present", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@localhost/openwork_den?socketPath=/a&socket=/b",
    )
    expect(config.socketPath).toBe("/a")
  })

  test("omits socketPath when neither parameter is present", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@127.0.0.1:3306/openwork_den",
    )
    expect(config).not.toHaveProperty("socketPath")
  })

  test("treats an empty ?socketPath as absent", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@127.0.0.1:3306/openwork_den?socketPath=",
    )
    expect(config).not.toHaveProperty("socketPath")
  })

  test("retains SSL settings alongside socketPath", () => {
    const config = parseMySqlConnectionConfig(
      "mysql://root:password@localhost/openwork_den?socketPath=/cloudsql/x&sslmode=require",
    )
    expect(config.socketPath).toBe("/cloudsql/x")
    expect(config.ssl).toEqual({ rejectUnauthorized: true })
  })

  test("throws when host, username, or database is missing", () => {
    expect(() => parseMySqlConnectionConfig("mysql://root@/db")).toThrow()
    expect(() => parseMySqlConnectionConfig("mysql://root@host/")).toThrow()
  })
})
