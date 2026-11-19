import { expect, test } from "bun:test";
import { confirmSharedGatewayProvider } from "../src/react-app/domains/connections/provider-auth/shared-provider-sync";

test("an absent Gateway provider stays pending after a bounded number of fresh checks", async () => {
  let reads = 0;
  let waits = 0;
  const result = await confirmSharedGatewayProvider({
    providerId: "openai", inferenceProviderId: "ipr_fixture", isCurrent: () => true, isListed: () => true,
    readGatewayProviders: async () => { reads += 1; return []; },
    readEngineProviders: async () => ({ all: [], connected: [], default: {} }),
    wait: async () => { waits += 1; }, attempts: 3,
  });
  expect(result).toEqual({ status: "pending" });
  expect(reads).toBe(3);
  expect(waits).toBe(2);
});

test("a changed account cancels before reading or publishing another inventory", async () => {
  let reads = 0;
  const result = await confirmSharedGatewayProvider({
    providerId: "openai", inferenceProviderId: "ipr_fixture", isCurrent: () => false, isListed: () => true,
    readGatewayProviders: async () => { reads += 1; return []; },
    readEngineProviders: async () => ({ all: [], connected: [], default: {} }),
    wait: async () => {},
  });
  expect(result).toEqual({ status: "pending" });
  expect(reads).toBe(0);
});
