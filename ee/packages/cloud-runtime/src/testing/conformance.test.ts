import { describe, test } from "bun:test"
import { sandboxProviderConformanceCases } from "./conformance"
import { createFakeProvider } from "./fake-provider"

describe("fake provider conformance", () => {
  for (const conformanceCase of sandboxProviderConformanceCases(() => createFakeProvider())) {
    test(conformanceCase.name, conformanceCase.run)
  }
})

describe("fake provider with stable endpoints", () => {
  const factory = () => createFakeProvider({ capabilities: { endpointKind: "stable", stopResume: false } })
  for (const conformanceCase of sandboxProviderConformanceCases(factory)) {
    test(conformanceCase.name, conformanceCase.run)
  }
})
