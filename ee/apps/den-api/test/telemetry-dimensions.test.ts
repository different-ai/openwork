import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"

const telemetryRouteSource = readFileSync(new URL("../src/routes/telemetry/index.ts", import.meta.url), "utf8")
const telemetrySchemaSource = readFileSync(new URL("../../../packages/den-db/src/schema/telemetry.ts", import.meta.url), "utf8")
const appTelemetrySource = readFileSync(new URL("../../../../apps/app/src/app/lib/den-telemetry.ts", import.meta.url), "utf8")
const analyticsScreenSource = readFileSync(new URL("../../den-web/app/(den)/dashboard/_components/analytics-screen.tsx", import.meta.url), "utf8")

test("telemetry dimensions are modeled as generic session dimensions", () => {
  expect(telemetrySchemaSource).toContain("TelemetrySessionDimensionTable")
  expect(telemetrySchemaSource).toContain('"telemetry_session_dimension"')
  expect(telemetrySchemaSource).toContain('"dimension_type"')
  expect(telemetrySchemaSource).toContain('"dimension_value"')
  expect(telemetrySchemaSource).toContain('"dimension_label"')
  expect(telemetrySchemaSource).toContain('json("metadata")')
  expect(telemetrySchemaSource).not.toContain("project_id")
  expect(telemetrySchemaSource).not.toContain("project_name")
})

test("telemetry dimension APIs use generic dimension routes and filters", () => {
  expect(telemetryRouteSource).toContain('"/v1/telemetry/sessions/:sessionId/dimensions/:type"')
  expect(telemetryRouteSource).toContain('"/v1/telemetry/dimensions"')
  expect(telemetryRouteSource).toContain("dimensionType")
  expect(telemetryRouteSource).toContain("dimensionValue")
  expect(telemetryRouteSource).toContain("dimensionLabel")
  expect(telemetryRouteSource).toContain("deriveDimensionValue")
  expect(telemetryRouteSource).not.toContain("project_id")
  expect(telemetryRouteSource).not.toContain("project_name")
})

test("project UI is backed by generic dimension APIs", () => {
  expect(appTelemetrySource).toContain("/v1/telemetry/sessions/")
  expect(appTelemetrySource).toContain("/dimensions/")
  expect(analyticsScreenSource).toContain("PROJECT_DIMENSION_TYPE = \"project\"")
  expect(analyticsScreenSource).toContain("/v1/telemetry/dimensions")
  expect(analyticsScreenSource).toContain("dimensionType")
  expect(analyticsScreenSource).toContain("dimensionLabel")
  expect(analyticsScreenSource).toContain("aggregateProjectOptions")
  expect(appTelemetrySource).not.toContain("projectId")
  expect(analyticsScreenSource).not.toContain("projectId")
})
