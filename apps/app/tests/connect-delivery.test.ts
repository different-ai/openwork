import { describe, expect, test } from "bun:test";

import {
  resolveMarketplaceDeliveryAction,
  shouldShowExtensionsMarketplacePane,
} from "../src/react-app/domains/settings/connect-delivery";

describe("Connect delivery switch decisions", () => {
  test("keeps the Extensions marketplace pane in both rollout modes", () => {
    expect(shouldShowExtensionsMarketplacePane()).toBe(true);
  });

  test("always delivers organization marketplace cards through Connect", () => {
    expect(resolveMarketplaceDeliveryAction({ importedLocally: false })).toBe("cloud_active");
    expect(resolveMarketplaceDeliveryAction({ importedLocally: true })).toBe("cloud_active_local_copy");
  });
});
