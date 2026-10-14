import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvitationPreviewPayload } from "./den-org";
import { parseOrganizationBrand } from "./organization-brand";

const customBrand = { appName: "Team Desktop", logoUrl: "https://example.com/logo.png", iconUrl: "https://example.com/icon.png" };
const stockBrand = { whiteLabelEnabled: false, appName: "OpenWork", logoUrl: null, iconUrl: null };

test("custom identity requires an explicit effective white-label flag", () => {
  for (const flag of [undefined, null, false, "true", 1]) {
    assert.deepEqual(parseOrganizationBrand(customBrand, flag), stockBrand);
  }
  assert.deepEqual(parseOrganizationBrand(customBrand, true), { whiteLabelEnabled: true, ...customBrand });
});

test("missing and old cached brand data fall back to stock identity", () => {
  assert.deepEqual(parseOrganizationBrand(undefined, undefined), stockBrand);
  assert.deepEqual(parseOrganizationBrand(null, true), stockBrand);
  assert.deepEqual(parseOrganizationBrand({}, true), { ...stockBrand, whiteLabelEnabled: true });
  assert.deepEqual(parseOrganizationBrand(customBrand, false), stockBrand);
});

test("invitation previews keep ordinary organization identity but suppress custom product identity when off or absent", () => {
  const invitation = { id: "inv_test", email: "member@example.com", role: "member", status: "pending" };
  const organization = { id: "org_test", name: "Example team", slug: "example-team", branding: customBrand };
  for (const flag of [undefined, false]) {
    const result = parseInvitationPreviewPayload({ invitation, organization: { ...organization, whiteLabelEnabled: flag } });
    assert.equal(result?.organization.name, "Example team");
    assert.deepEqual(result?.organization.branding, stockBrand);
  }
  assert.deepEqual(parseInvitationPreviewPayload({ invitation, organization: { ...organization, whiteLabelEnabled: true } })?.organization.branding,
    { ...customBrand, whiteLabelEnabled: true });
  assert.deepEqual(parseInvitationPreviewPayload({ invitation, organization: { id: "org_test", name: "Example team", slug: "example-team" } })?.organization.branding, stockBrand);
});
