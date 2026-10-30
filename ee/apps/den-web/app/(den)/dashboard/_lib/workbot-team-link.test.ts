import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedWorkbotOrganization, workbotLinkPurpose } from "./workbot-team-link";

const organizations = [{ id: "org_other" }, { id: "org_workbot" }];
const link = (path: string) => `https://console.example.test/dashboard/${path}${path.includes("?") ? "&" : "?"}workbotOrganizationId=org_workbot`;

test("setup destinations select the Workbot workspace independently of model recovery", () => {
  for (const path of ["members", "library?show=skills", "library?show=models", "library?show=connectors", "ai-gateway?tab=ai-providers"]) {
    assert.equal(workbotLinkPurpose(link(path)), "setup", path);
    assert.equal(linkedWorkbotOrganization(link(path), organizations), "org_workbot", path);
  }
});

test("model recovery destinations remain distinct from setup", () => {
  for (const path of ["workbot-settings", "billing", "ai-gateway?tab=openwork-models"]) {
    assert.equal(workbotLinkPurpose(link(path)), "recovery", path);
    assert.equal(linkedWorkbotOrganization(link(path), organizations), "org_workbot", path);
  }
});

test("a linked workspace must be a current membership and have exactly one nonempty hint", () => {
  for (const href of [
    link("members").replace("org_workbot", "org_outside"),
    link("members").replace("org_workbot", ""),
    `${link("members")}&workbotOrganizationId=org_other`,
    `${link("members")}&workbotOrganizationId=org_workbot`,
  ]) assert.throws(() => linkedWorkbotOrganization(href, organizations), /Workbot workspace is unavailable/);
  assert.equal(linkedWorkbotOrganization("https://console.example.test/dashboard/members", organizations), null);
});

test("unrecognized destinations and ambiguous setup tabs fail closed", () => {
  for (const path of ["", "members/elsewhere", "library", "library?show=other", "library?show=skills&show=models", "ai-gateway", "ai-gateway?tab=other", "ai-gateway?tab=ai-providers&tab=openwork-models"]) {
    assert.equal(workbotLinkPurpose(link(path)), null, path);
    assert.throws(() => linkedWorkbotOrganization(link(path), organizations), /Workbot workspace is unavailable/, path);
  }
});
