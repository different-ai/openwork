import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(packageDir, "..", "..", "..")
const forbiddenDeployTools = ["pnpm", "tsx", "tsup", "drizzle-kit"]
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function requireSlice(contents: string, start: string, end: string) {
  const startIndex = contents.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing ${start}`)

  const endIndex = contents.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing ${end}`)

  return contents.slice(startIndex, endIndex)
}

function assertNoForbiddenDeployTools(contents: string) {
  for (const tool of forbiddenDeployTools) {
    assert.equal(contents.includes(tool), false, `deploy path must not reference ${tool}`)
  }
}

function shortOutput(output: string) {
  return output.slice(Math.max(0, output.length - 4_000))
}

describe("Den DB migration readiness wiring", () => {
  test("Helm migration defaults execute the precompiled dist runner", () => {
    const values = readRepoFile("packaging/helm/openwork-ee/values.yaml")
    const migrationsBlock = requireSlice(values, "migrations:\n", "\ningress:")

    assert.match(migrationsBlock, /command:\n\s+- node/)
    assert.match(migrationsBlock, /args:\n\s+- \/app\/ee\/packages\/den-db\/dist\/scripts\/bootstrap\.js/)
    assertNoForbiddenDeployTools(migrationsBlock)
  })

  test("Dockerfile.den builds Den DB dist assets before the Den API image build", () => {
    const dockerfile = readRepoFile("packaging/docker/Dockerfile.den")
    const denDbBuildIndex = dockerfile.indexOf("RUN pnpm --dir /app/ee/packages/den-db run build")
    const denApiBuildIndex = dockerfile.indexOf("pnpm --dir /app/ee/apps/den-api run build")

    assert.notEqual(denDbBuildIndex, -1, "Dockerfile.den builds @openwork-ee/den-db")
    assert.notEqual(denApiBuildIndex, -1, "Dockerfile.den builds @openwork-ee/den-api")
    assert.ok(denDbBuildIndex < denApiBuildIndex, "den-db dist assets are built before den-api")
  })

  test("hosted Den API build includes den-db assets but start does not run migrations", () => {
    const denApiPackage = readRepoFile("ee/apps/den-api/package.json")
    const denApiBuild = readRepoFile("ee/apps/den-api/scripts/build.mjs")
    const startLine = denApiPackage.split("\n").find((line) => line.includes('"start"')) ?? ""

    assert.match(denApiPackage, /"build:den-db": "pnpm --filter @openwork-ee\/den-db build"/)
    assert.match(denApiBuild, /run\(pnpmCommand, \["run", "build:den-db"\]\)/)
    assert.match(startLine, /"start": "node dist\/main\.js"/)
    assert.equal(startLine.includes("db:migrate"), false, "hosted start alone does not migrate")
    assert.equal(startLine.includes("db:bootstrap"), false, "hosted start alone does not bootstrap")
    assert.equal(startLine.includes("bootstrap.js"), false, "hosted start alone does not invoke the migration runner")
  })

  test("hosted migration workflow remains the explicit PlanetScale migration owner", () => {
    const workflow = readRepoFile(".github/workflows/den-db-migrate.yml")

    assert.match(workflow, /name: Den DB Migrate/)
    assert.match(workflow, /branches:\n\s+- dev/)
    assert.match(workflow, /paths:\n\s+- "ee\/packages\/den-db\/drizzle\/\*\*"/)
    assert.match(workflow, /pscale branch safe-migrations disable/)
    assert.match(workflow, /run_with_ddl_retry pnpm --filter @openwork-ee\/den-db db:migrate/)
    assert.match(workflow, /pscale branch safe-migrations enable/)
  })

  test("PR guardrails run readiness tests and smoke Den DB assets in the Den API image", () => {
    const checkWorkflow = readRepoFile(".github/workflows/den-db-check.yml")
    const publishWorkflow = readRepoFile(".github/workflows/publish-ee-images.yml")

    assert.match(checkWorkflow, /pnpm --filter @openwork-ee\/den-db test/)
    assert.match(checkWorkflow, /"ee\/apps\/den-api\/package\.json"/)
    assert.match(checkWorkflow, /"ee\/apps\/den-api\/scripts\/build\.mjs"/)
    assert.match(checkWorkflow, /"packaging\/docker\/Dockerfile\.den"/)
    assert.match(checkWorkflow, /"packaging\/helm\/openwork-ee\/templates\/migration-job\.yaml"/)
    assert.match(checkWorkflow, /"\.github\/workflows\/publish-ee-images\.yml"/)
    assert.match(publishWorkflow, /Assert Den DB migration assets/)
    assert.match(publishWorkflow, /test -s \/app\/ee\/packages\/den-db\/dist\/scripts\/bootstrap\.js/)
    assert.match(publishWorkflow, /test -s \/app\/ee\/packages\/den-db\/dist\/current-schema\.sql/)
    assert.match(publishWorkflow, /test -s \/app\/ee\/packages\/den-db\/dist\/drizzle\/meta\/_journal\.json/)
  })

  test("production bootstrap source uses the mysql2 ORM migrator and no deploy-time toolchain", () => {
    const bootstrap = readFileSync(path.join(packageDir, "scripts", "bootstrap.ts"), "utf8")

    assert.match(bootstrap, /drizzle-orm\/mysql2\/migrator/)
    assert.match(bootstrap, /await migrate\(db, \{ migrationsFolder \}\)/)
    assert.match(bootstrap, /current-schema\.sql/)
    assert.match(bootstrap, /await ensureFulltextIndexes\(indexExecutor\)/)
    assertNoForbiddenDeployTools(bootstrap)
  })

  test("package build emits the precompiled runner, schema snapshot, and migration assets", { timeout: 120_000 }, () => {
    const build = spawnSync(pnpmCommand, ["run", "build"], {
      cwd: packageDir,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_HOST: "",
        DATABASE_NAME: "",
        DATABASE_PASSWORD: "",
        DATABASE_URL: "",
        DATABASE_USERNAME: "",
      },
    })

    assert.equal(
      build.status,
      0,
      `pnpm run build failed\nstdout:\n${shortOutput(build.stdout)}\nstderr:\n${shortOutput(build.stderr)}`,
    )

    const runner = readFileSync(path.join(packageDir, "dist", "scripts", "bootstrap.js"), "utf8")
    const snapshot = readFileSync(path.join(packageDir, "dist", "current-schema.sql"), "utf8")
    const journal = readFileSync(path.join(packageDir, "dist", "drizzle", "meta", "_journal.json"), "utf8")

    assert.match(runner, /drizzle-orm\/mysql2\/migrator/)
    assert.match(snapshot, /^CREATE TABLE `account`/)
    assert.equal(snapshot.includes("Reading schema files"), false, "schema snapshot contains SQL only")
    assert.match(journal, /"entries"/)
    assert.match(journal, /"0040_rapid_lady_bullseye"/)
  })
})
