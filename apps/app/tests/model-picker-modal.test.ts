import { describe, expect, test } from "bun:test";

import {
  MODEL_PICKER_DEFAULT_SUBTITLE,
  MODEL_PICKER_UNAVAILABLE_SUBTITLE,
  resolveModelPickerSubtitle,
  resolveProviderGroupBadges,
} from "../src/react-app/domains/session/modals/model-picker-modal";
import {
  isCloudManagedProviderKey,
  resolveGatewayProviderIds,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

describe("model picker subtitle", () => {
  test("keeps the normal session subtitle by default", () => {
    expect(resolveModelPickerSubtitle(undefined)).toBe(MODEL_PICKER_DEFAULT_SUBTITLE);
  });

  test("supports the unavailable-model recovery subtitle", () => {
    expect(resolveModelPickerSubtitle(MODEL_PICKER_UNAVAILABLE_SUBTITLE)).toBe(
      "The model you were using is no longer available, please select a different model for this session.",
    );
  });
});

describe("model picker provider badges", () => {
  const importedCloudProviders = {
    ipr_gateway: { providerId: "ipr_gateway", source: "openwork_gateway" },
    lpr_team: { providerId: "lpr_team", source: "custom" },
  };
  const labels = (group: Parameters<typeof resolveProviderGroupBadges>[0]) =>
    resolveProviderGroupBadges(group, "Acme").map((badge) => badge.label);

  test("treats inference gateway rows as cloud-managed provider keys", () => {
    expect(isCloudManagedProviderKey("ipr_gateway")).toBe(true);
    expect(isCloudManagedProviderKey("lpr_team")).toBe(true);
    expect(isCloudManagedProviderKey("anthropic")).toBe(false);
  });

  test("badges only providers whose sync status source is the OpenWork gateway", () => {
    const gatewayProviderIds = resolveGatewayProviderIds(importedCloudProviders);
    expect([...gatewayProviderIds]).toEqual(["ipr_gateway"]);

    const gateway = labels({
      isNew: false,
      isCloud: true,
      isGateway: gatewayProviderIds.has("ipr_gateway"),
      hasCurrent: false,
    });
    expect(gateway).toEqual(["Acme", "via OpenWork Gateway"]);

    const organization = labels({
      isNew: false,
      isCloud: true,
      isGateway: gatewayProviderIds.has("lpr_team"),
      hasCurrent: true,
    });
    expect(organization).toEqual(["Acme", "Current"]);
    expect(organization).not.toContain("via OpenWork Gateway");
  });
});
