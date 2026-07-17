declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  isOpenWorkModelsPromoEligible,
  isOpenWorkModelsPromoEligibleForDenBaseUrl,
  shouldShowOpenWorkModelsPromo,
  wasOpenWorkModelsStartupPromoShown,
} from "./openwork-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("OpenWork Models promo eligibility", () => {
  test("allows promotions on the default Den URL after normalization", () => {
    expect(isOpenWorkModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(true);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isOpenWorkModelsPromoEligible()).toBe(false);
    expect(shouldShowOpenWorkModelsPromo()).toBe(false);
    expect(wasOpenWorkModelsStartupPromoShown()).toBe(true);
  });
});
