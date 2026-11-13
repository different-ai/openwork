import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gaFeatureRetirementWorld } from "../worlds/ga-feature-retirement.ts";

const test = spec.world(gaFeatureRetirementWorld, {
  timeout: 600_000,
  resources: { surfaces: [], services: ["den"] },
});

// A fixed regression list: deriving this from the registry would make accidental restoration pass.
const retired = [
  "claudeAgentProvider", "webPerMember", "localModelsPolicy", "shareDeviceProvider",
  "singleOpenWorkModelsRow", "passwordSignInGoogle", "signInEmailSync", "ssoOidcSetupCheck",
  "denPageConsistency", "nativeDictation", "workbotScrollToBottom", "workbotApps",
  "workbotProactive", "workbotTeamSettings", "workbotUsageAnalytics", "fileSendPermissions",
  "remoteDevices", "remoteSessionAccess",
];
const retained = ["workbotDocuments", "remoteComputers", "remoteTasksOptIn"];

test("GA features cannot reappear in platform, organization, member or usage rollout editors", async ({ world, step, evidence }) => {
  const surfaces = [
    { path: "/v1/admin/features", field: "features" },
    { path: `${world.organizationPath}/capabilities`, field: "capabilities" },
    { path: `${world.organizationPath}/capabilities`, field: "featureStates" },
    { path: world.memberPath, field: "featureStates" },
    { path: "/v1/admin/feature-usage", field: "features" },
    { path: `${world.organizationPath}/feature-usage`, field: "features" },
  ];
  for (const surface of surfaces) {
    await step(`the real ${surface.path} ${surface.field} list omits all 18 retired keys`, async () => {
      if (surface.field !== "features" && surface.field !== "capabilities" && surface.field !== "featureStates") throw new Error("Unknown list field");
      const keys = await world.list(surface.path, surface.field);
      const resurrected = retired.filter(key => keys.includes(key));
      expect(resurrected).toEqual([]);
      for (const key of retained) expect(keys).toContain(key);
      evidence.recordAssertionEvidence("Retired GA rollouts absent; independent non-GA controls retained", `${surface.field}: ${keys.join(", ")}; retired present=${resurrected.join(", ") || "none"}`, resurrected.length === 0 && retained.every(key => keys.includes(key)));
    });
  }
  await step("the platform cannot switch retired behavior off through the old global routes", async () => {
    for (const key of retired) {
      const status = await world.changeGlobal(key);
      expect(status).toBe(400);
      evidence.recordAssertionEvidence("A retired key is no longer a mutable rollout", `${key}: PUT enabled=false,killed=true → ${status}`, status === 400);
    }
  });
  await step("ordinary members still cannot access the platform feature editor", async () => {
    const status = await world.memberRead();
    expect(status).toBe(403);
    evidence.recordAssertionEvidence("Retirement does not weaken platform authorization", `member GET /v1/admin/features → ${status}`, status === 403);
  });
});
