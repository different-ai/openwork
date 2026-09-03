import { describe, expect, test } from "bun:test"
import { parseStoredDashboardElements } from "../src/routes/org/dashboard-elements.js"

const budgetApp = {
  serverName: "openwork-app-host-connect-budgetfixture",
  connectionId: "emc_01budgetdashboardfixture00000",
  toolName: "allocate_budget",
  projectedToolName: "openwork-app-host-connect-budgetfixture_allocate_budget",
  resourceUri: "ui://budget-allocator/view.html",
  title: "Budget allocator",
}

describe("stored dashboard elements", () => {
  test("accepts native JSON arrays", () => {
    expect(parseStoredDashboardElements([budgetApp])).toEqual([budgetApp])
  })

  test("decodes MySQL drivers that return the JSON column as text", () => {
    expect(parseStoredDashboardElements(JSON.stringify([budgetApp]))).toEqual([budgetApp])
  })

  test("does not expose malformed stored values", () => {
    expect(parseStoredDashboardElements("not JSON")).toEqual([])
    expect(parseStoredDashboardElements(JSON.stringify([{ ...budgetApp, resourceUri: "https://example.com" }]))).toEqual([])
  })
})
