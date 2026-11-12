import assert from "node:assert/strict";
import test from "node:test";
import { buildTrueFoundryCreateBody, trueFoundryAttentionLabel, trueFoundryCreateError, trueFoundrySyncSummary } from "./truefoundry-provider-data";

const access = { allMembers: false, memberIds: ["om_1", "om_1"], teamIds: ["tem_1"] };

test("the create body carries the address, key, missing-users setting and audiences", () => {
  assert.deepEqual(buildTrueFoundryCreateBody({ name: " ", controlPlaneUrl: " https://acme.truefoundry.cloud ", apiKey: " tfy_va_admin ", createMissingUsers: true, access }), {
    name: "TrueFoundry", controlPlaneUrl: "https://acme.truefoundry.cloud", apiKey: "tfy_va_admin", createMissingUsers: true, memberIds: ["om_1"], teamIds: ["tem_1"],
  });
  assert.deepEqual(buildTrueFoundryCreateBody({ name: "TF", controlPlaneUrl: "https://acme.truefoundry.cloud", apiKey: "k", createMissingUsers: false, access: { allMembers: true, memberIds: [], teamIds: [] } }), {
    name: "TF", controlPlaneUrl: "https://acme.truefoundry.cloud", apiKey: "k", createMissingUsers: false, allMembers: true,
  });
});

test("setup refuses a missing address, a missing key and personal access tokens before calling Den", () => {
  assert.match(trueFoundryCreateError({ controlPlaneUrl: "", apiKey: "tfy_va_x" }) ?? "", /address/);
  assert.match(trueFoundryCreateError({ controlPlaneUrl: "acme", apiKey: "tfy_va_x" }) ?? "", /full address/);
  assert.match(trueFoundryCreateError({ controlPlaneUrl: "https://acme.truefoundry.cloud", apiKey: " " }) ?? "", /virtual account/);
  assert.match(trueFoundryCreateError({ controlPlaneUrl: "https://acme.truefoundry.cloud", apiKey: "tfy_pat_me_123" }) ?? "", /personal access token/);
  assert.equal(trueFoundryCreateError({ controlPlaneUrl: "https://acme.truefoundry.cloud", apiKey: "tfy_va_admin" }), null);
});

test("sync summaries and attention labels read plainly", () => {
  assert.equal(trueFoundrySyncSummary({ modelCount: 3, people: 1, tokensCreated: 1, usersCreated: 2, notInTrueFoundry: 1, noModels: 2, tokenLimit: 0, errors: 0, removed: 1 }),
    "Synced 3 models, keys for 1 person, 2 added to TrueFoundry, 3 need attention, 1 removed.");
  assert.equal(trueFoundryAttentionLabel("not_in_truefoundry"), "Not in TrueFoundry");
  assert.equal(trueFoundryAttentionLabel("token_limit"), "Too many tokens");
});
