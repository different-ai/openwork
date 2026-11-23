import assert from "node:assert/strict";
import { test } from "node:test";
import { workbotBaseUrl, workbotDestination } from "./destination.ts";

for (const deployment of [undefined, "", "self_hosted", " self_hosted ", "invalid"]) {
  test(`an unconfigured ${deployment ?? "default"} deployment has no hosted Workbot fallback`, () => {
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }), null);
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment, DEN_WORKBOT_URL: "  " }), null);
  });
}

test("Cloud retains its hosted Workbot fallback", () => {
  assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: "cloud" }), "https://chat.openworklabs.com");
  assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: " cloud ", DEN_WORKBOT_URL: " " }), "https://chat.openworklabs.com");
});

for (const deployment of [undefined, "self_hosted", "cloud"]) {
  test(`explicit manual Workbot URL wins for ${deployment ?? "default"} deployment`, () => {
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment, DEN_WORKBOT_URL: " https://manual.example.test/chat?source=den " }), "https://manual.example.test/chat?source=den");
  });
}

test("the member's organization is forwarded without changing existing query parameters", () => {
  assert.equal(workbotDestination("https://manual.example.test/chat?source=den", "org_123"), "https://manual.example.test/chat?source=den&organization=org_123");
});

test("an ambiguous or invalid organization parameter is not forwarded", () => {
  for (const organizationId of [undefined, ["org_one", "org_two"], "", "../other", "org?token=private"]) {
    assert.equal(workbotDestination("https://manual.example.test", organizationId), "https://manual.example.test");
  }
});
