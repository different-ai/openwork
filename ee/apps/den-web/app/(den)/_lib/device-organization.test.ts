import assert from "node:assert/strict";
import { test } from "node:test";
import { initialDeviceOrganizationId } from "./device-organization";

const organizations = [
  { id: "organization-b", isActive: false },
  { id: "organization-a", isActive: true },
];

test("desktop approval starts empty with multiple organizations even when one is active", () => {
  assert.equal(initialDeviceOrganizationId("openwork-desktop-device", organizations), "");
  assert.equal(initialDeviceOrganizationId("openwork-desktop-device", organizations.map((organization) => ({ ...organization, isActive: false }))), "");
});

test("desktop approval selects the only organization without requiring a picker", () => {
  assert.equal(initialDeviceOrganizationId("openwork-desktop-device", [organizations[0]!]), "organization-b");
  assert.equal(initialDeviceOrganizationId("openwork-desktop-device", [organizations[1]!]), "organization-a");
  assert.equal(initialDeviceOrganizationId("openwork-desktop-device", []), "");
});

for (const clientId of ["openwork-cli", "openwork-opencode-plugin", "another-client", null]) {
  test(`${clientId ?? "unknown client"} keeps the active organization and first-organization fallback`, () => {
    assert.equal(initialDeviceOrganizationId(clientId, organizations), "organization-a");
    assert.equal(initialDeviceOrganizationId(clientId, organizations.map((organization) => ({ ...organization, isActive: false }))), "organization-b");
    assert.equal(initialDeviceOrganizationId(clientId, []), "");
  });
}
