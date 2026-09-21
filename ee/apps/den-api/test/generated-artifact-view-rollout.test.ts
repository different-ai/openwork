import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeGeneratedArtifactViews(value?: string) {
  return probeEnvFlag("generatedArtifactViewsEnabled", "DEN_GENERATED_ARTIFACT_VIEWS_ENABLED", value)
}

function probeEnvFlag(field: string, variable: string, value?: string) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify(env[${JSON.stringify(field)}]))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.openwork.test",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(value === undefined ? {} : { [variable]: value }),
    },
  })
}

test("the organization Code Mode opt-in stays inert until the deployment enables it", () => {
  const probe = (value?: string) => probeEnvFlag("codeModeOptInEnabled", "DEN_CODE_MODE_OPT_IN_ENABLED", value)
  expect(probe().stdout.trim()).toBe("false")
  expect(probe("false").stdout.trim()).toBe("false")
  expect(probe("true").stdout.trim()).toBe("true")
})

test("generated Artifact views stay disabled until the compatible Desktop rollout is enabled", () => {
  const unset = probeGeneratedArtifactViews()
  const disabled = probeGeneratedArtifactViews("false")
  const enabled = probeGeneratedArtifactViews("true")

  expect(unset.status).toBe(0)
  expect(unset.stdout.trim()).toBe("false")
  expect(disabled.status).toBe(0)
  expect(disabled.stdout.trim()).toBe("false")
  expect(enabled.status).toBe(0)
  expect(enabled.stdout.trim()).toBe("true")
})
