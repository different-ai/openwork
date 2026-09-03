import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createDenDb } from "@openwork-ee/den-db"
import { sql } from "@openwork-ee/den-db/drizzle"

const testDirectory = resolve("test")
const testFiles = (await readdir(testDirectory)).filter((file) => file.endsWith(".test.ts"))
const testSources = await Promise.all(
  testFiles.map((file) => readFile(resolve(testDirectory, file), "utf8")),
)
const databaseNames = [...new Set(testSources.flatMap((source) =>
  [...source.matchAll(/mysql:\/\/root:password@127\.0\.0\.1:3306\/(openwork_test(?:_[A-Za-z0-9_]+)?)/g)]
    .map((match) => match[1]),
))].sort()

if (databaseNames.length === 0) {
  throw new Error("No Den API test databases were found")
}

const schemaSource = await readFile(resolve("../../packages/den-db/dist/current-schema.sql"), "utf8")
const schemaStatements = schemaSource
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean)

if (schemaStatements.length === 0) {
  throw new Error("The Den database schema snapshot was empty")
}

const adminDatabase = createDenDb({
  databaseUrl: "mysql://root:password@127.0.0.1:3306/mysql",
  mode: "mysql",
})

try {
  for (const databaseName of databaseNames) {
    await adminDatabase.db.execute(sql.raw(`DROP DATABASE IF EXISTS \`${databaseName}\``))
    await adminDatabase.db.execute(sql.raw(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ))

    const testDatabase = createDenDb({
      databaseUrl: `mysql://root:password@127.0.0.1:3306/${databaseName}`,
      mode: "mysql",
    })
    try {
      for (const statement of schemaStatements) {
        await testDatabase.db.execute(sql.raw(statement))
      }
    } finally {
      await testDatabase.client.end()
    }
  }
} finally {
  await adminDatabase.client.end()
}

console.log(`Prepared ${databaseNames.length} Den API test databases.`)
