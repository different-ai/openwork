import { expect, test } from "bun:test"
import { deriveDimensionValue } from "../src/routes/telemetry/dimension-value.js"

const dimensionValuePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/

test("deriveDimensionValue is deterministic", () => {
  expect(deriveDimensionValue("project", "Billing API")).toBe(deriveDimensionValue("project", "Billing API"))
})

test("deriveDimensionValue ignores label trim and case", () => {
  expect(deriveDimensionValue("project", "Billing API")).toBe(deriveDimensionValue("project", "  billing api  "))
})

test("deriveDimensionValue includes a slug prefix", () => {
  expect(deriveDimensionValue("project", "Billing API").startsWith("billing-api-")).toBe(true)
})

test("deriveDimensionValue changes for different labels", () => {
  expect(deriveDimensionValue("project", "Billing API")).not.toBe(deriveDimensionValue("project", "Support API"))
})

test("deriveDimensionValue changes for different types", () => {
  expect(deriveDimensionValue("project", "Billing API")).not.toBe(deriveDimensionValue("team", "Billing API"))
})

test("deriveDimensionValue slugifies accented labels", () => {
  expect(deriveDimensionValue("project", "Café Ops").startsWith("cafe-ops-")).toBe(true)
})

test("deriveDimensionValue falls back for symbol-only labels", () => {
  expect(deriveDimensionValue("project", "!!!").startsWith("dimension-")).toBe(true)
})

test("deriveDimensionValue returns a valid bounded dimension value", () => {
  const value = deriveDimensionValue("project", "A".repeat(300))
  expect(value).toMatch(dimensionValuePattern)
  expect(value.length).toBeLessThanOrEqual(128)
})
