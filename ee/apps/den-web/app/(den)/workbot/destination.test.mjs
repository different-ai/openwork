import assert from "node:assert/strict";
import { test } from "node:test";
import { workbotBaseUrl, workbotDestination } from "./destination.ts";

for (const deployment of ["self_hosted", " self_hosted "]) {
  test(`an unconfigured ${deployment} deployment changes only with the explicit feature on`, () => {
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }), "https://chat.openworklabs.com");
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }, false), "https://chat.openworklabs.com");
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }, true), null);
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment, DEN_WORKBOT_URL: "  " }, true), null);
  });
}

for (const deployment of [undefined, "", "invalid", "cloud", " cloud "]) {
  test(`the ${deployment ?? "unset"} deployment preserves the historical hosted fallback`, () => {
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }), "https://chat.openworklabs.com");
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment, DEN_WORKBOT_URL: " " }), "https://chat.openworklabs.com");
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }, true), "https://chat.openworklabs.com");
    assert.equal(workbotDestination(workbotBaseUrl({ DEN_DEPLOYMENT: deployment }), "org_legacy"), "https://chat.openworklabs.com/?organization=org_legacy");
  });
}

for (const deployment of [undefined, "invalid", "self_hosted", "cloud"]) {
  test(`explicit manual Workbot URL wins for ${deployment ?? "default"} deployment`, () => {
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment, DEN_WORKBOT_URL: " https://manual.example.test/chat?source=den " }), "https://manual.example.test/chat?source=den");
    assert.equal(workbotBaseUrl({ DEN_DEPLOYMENT: deployment, DEN_WORKBOT_URL: " https://manual.example.test/chat?source=den " }, true), "https://manual.example.test/chat?source=den");
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
