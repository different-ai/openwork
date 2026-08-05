declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasMicxModelsAvailable,
  isMicxModelsPromoEligible,
  isMicxModelsPromoEligibleForDenBaseUrl,
  shouldShowMicxModelsPromo,
  wasMicxModelsStartupPromoShown,
} from "./micx-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("Micx Models promo eligibility", () => {
  test("allows promotions on the default Den URL after normalization", () => {
    expect(isMicxModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(true);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isMicxModelsPromoEligible()).toBe(false);
    expect(shouldShowMicxModelsPromo()).toBe(false);
    expect(wasMicxModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasMicxModelsAvailable", () => {
  test("requires a connected micx provider with at least one model", () => {
    expect(
      hasMicxModelsAvailable({
        providerConnectedIds: ["micx"],
        providers: [{ id: "micx", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasMicxModelsAvailable({
        providerConnectedIds: ["micx"],
        providers: [{ id: "micx", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});
