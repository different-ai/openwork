import { expect, test } from "bun:test"
import { deriveDimensionValue } from "@openwork-ee/telemetry"

const VALUE_CONTRACT = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/

test("same type and label always derive the same value", () => {
  const first = deriveDimensionValue("project", "Billing API")
  const second = deriveDimensionValue("project", "Billing API")
  expect(first).toBe(second)
})

test("derivation is insensitive to label whitespace and casing", () => {
  expect(deriveDimensionValue("project", "  billing api  ")).toBe(deriveDimensionValue("project", "Billing API"))
})

test("derived values start with a readable slug of the label", () => {
  expect(deriveDimensionValue("project", "Billing API")).toStartWith("billing-api-")
})

test("different labels derive different values", () => {
  expect(deriveDimensionValue("project", "Billing API")).not.toBe(deriveDimensionValue("project", "Support API"))
})

test("the dimension type participates in derivation", () => {
  expect(deriveDimensionValue("project", "Billing API")).not.toBe(deriveDimensionValue("team", "Billing API"))
})

test("accented labels fold to ascii slugs", () => {
  expect(deriveDimensionValue("project", "Café Ops")).toStartWith("cafe-ops-")
})

test("labels with no usable characters fall back to a generic slug", () => {
  expect(deriveDimensionValue("project", "!!!")).toStartWith("dimension-")
})

test("derived values satisfy the dimension value contract at any label length", () => {
  const value = deriveDimensionValue("project", "A".repeat(300))
  expect(value).toMatch(VALUE_CONTRACT)
  expect(value.length).toBeLessThanOrEqual(128)
})
