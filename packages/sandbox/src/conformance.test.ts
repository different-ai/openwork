import { test } from "node:test"
import { createFakeProvider, sandboxProviderConformanceCases } from "./testing"

// The fake is the reference provider: every case must hold for it, so the
// cases themselves stay honest before they run against a real provider.
for (const conformanceCase of sandboxProviderConformanceCases(() => createFakeProvider())) {
  test(`fake provider: ${conformanceCase.name}`, conformanceCase.run)
}
