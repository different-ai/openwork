import assert from "node:assert/strict"
import test from "node:test"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

test("parses a Cloud SQL Unix socket from DATABASE_URL", () => {
  assert.deepEqual(
    parseMySqlConnectionConfig(
      "mysql://openwork:secret@localhost/openwork_den?socket=%2Fcloudsql%2Fexample%3Aus-central1%3Aopenwork",
    ),
    {
      host: "localhost",
      port: 3306,
      user: "openwork",
      password: "secret",
      database: "openwork_den",
      socketPath: "/cloudsql/example:us-central1:openwork",
      ssl: undefined,
    },
  )
})

test("keeps TCP database URLs unchanged", () => {
  assert.deepEqual(parseMySqlConnectionConfig("mysql://openwork:secret@10.0.0.4:3307/openwork_den"), {
    host: "10.0.0.4",
    port: 3307,
    user: "openwork",
    password: "secret",
    database: "openwork_den",
    ssl: undefined,
  })
})
