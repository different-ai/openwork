import { describe, expect, test } from "bun:test";

import {
  MODEL_PICKER_DEFAULT_SUBTITLE,
  MODEL_PICKER_UNAVAILABLE_SUBTITLE,
  resolveModelPickerSubtitle,
  resolveProviderGroupBadges,
} from "../src/react-app/domains/session/modals/model-picker-modal";
import {
  connectGatewayProvider,
  gatewayConnectCopy,
  isCloudManagedProviderKey,
  resolveGatewayConnectProviders,
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

describe("gateway member sign-in", () => {
  const skipped = {
    ipr_member: {
      cloudProviderId: "ipr_member",
      providerId: "ipr_member",
      name: "Member Vertex",
      reason: "member_auth_required",
      authUrl: "https://den.example.test/v1/inference-providers/ipr_member/oauth/start",
    },
    ipr_org: { cloudProviderId: "ipr_org", providerId: "ipr_org", name: "Org Anthropic", reason: "org_credential_missing", authUrl: null },
    lpr_team: { cloudProviderId: "lpr_team", providerId: "lpr_team", name: "Team", reason: "missing_credentials" },
  };

  test("surfaces only member_auth_required skips as Connect rows with the sign-in copy", () => {
    const rows = resolveGatewayConnectProviders(skipped);
    expect(rows).toEqual([{
      cloudProviderId: "ipr_member",
      providerId: "ipr_member",
      name: "Member Vertex",
      authUrl: "https://den.example.test/v1/inference-providers/ipr_member/oauth/start",
    }]);
    expect(gatewayConnectCopy(rows[0]!.name)).toBe("Sign in to Member Vertex to use it");
    expect(resolveGatewayConnectProviders(undefined)).toEqual([]);
  });

  test("Connect opens authUrl in the browser, then re-syncs until the provider is no longer skipped", async () => {
    const opened: string[] = [];
    let syncs = 0;
    const waits: number[] = [];
    const connected = await connectGatewayProvider({
      provider: resolveGatewayConnectProviders(skipped)[0]!,
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; },
      isConnected: () => syncs >= 3,
      wait: async (ms) => { waits.push(ms); },
      pollIntervalMs: 10_000,
      attempts: 6,
    });
    expect(opened).toEqual(["https://den.example.test/v1/inference-providers/ipr_member/oauth/start"]);
    expect(connected).toBe(true);
    expect(syncs).toBe(3);
    expect(waits).toEqual([10_000, 10_000, 10_000]);
  });

  test("Connect gives up after the poll budget and never opens a browser without an authUrl", async () => {
    const opened: string[] = [];
    let syncs = 0;
    const provider = resolveGatewayConnectProviders(skipped)[0]!;
    expect(await connectGatewayProvider({
      provider,
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; throw new Error("den offline"); },
      isConnected: () => false,
      wait: async () => undefined,
      attempts: 2,
    })).toBe(false);
    expect(syncs).toBe(2);
    expect(opened).toHaveLength(1);

    expect(await connectGatewayProvider({
      provider: { ...provider, authUrl: null },
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; },
      isConnected: () => true,
    })).toBe(false);
    expect(opened).toHaveLength(1);
    expect(syncs).toBe(2);
  });
});
