import assert from "node:assert/strict";
import { test } from "node:test";
import { auditFiltersFromDraft, auditLocalDate, normalizeAllowedEmailDomainsInput, pendingAuditSearch, refreshedDraft, sameStringSet, settingsDraftChanged } from "./page-consistency-state";

const saved = {
  name: "Example workspace", domains: ["example.com", "partner.test"], domainRestrictionsEnabled: true,
  desktopVersions: ["1.2.3", "1.2.4"],
};
const compare = { compareVersions: true };

test("audit draft validation rejects invalid dates and reversed ranges without serializing or mutating the draft", () => {
  for (const draft of [
    { from: "not a date" }, { to: "not a date" },
    { from: "2026-11-12T12:00", to: "2026-11-11T12:00", searchId: "  request-id  " },
  ]) {
    const original = { ...draft };
    assert.equal(auditFiltersFromDraft(draft), null);
    assert.deepEqual(draft, original);
  }
});

test("automatic audit searches are debounced and never request invalid ranges", () => {
  assert.equal(pendingAuditSearch({ searchId: "  applied-id  " }, "applied-id"), null);
  assert.equal(pendingAuditSearch({ searchId: "draft-id", from: "invalid" }), null);
  assert.equal(pendingAuditSearch({ searchId: "draft-id", from: "2026-11-12T12:00", to: "2026-11-11T12:00" }), null);
  assert.equal(pendingAuditSearch({ searchId: "  draft-id  " })?.searchId, "draft-id");
});

test("valid audit drafts normalize IDs and local date endpoints, retaining every facet", () => {
  const draft = { from: "2026-11-12T12:00", to: "2026-11-12T12:00", searchId: "  request-id  ", actorId: "actor-id", action: "organization.updated" };
  assert.deepEqual(auditFiltersFromDraft(draft), { ...draft, searchId: "request-id", from: new Date(draft.from).toISOString(), to: new Date(draft.to).toISOString() });
  assert.deepEqual(auditFiltersFromDraft({ searchId: "   " }), { searchId: undefined, from: undefined, to: undefined });
  assert.equal(auditFiltersFromDraft({ from: "2026-11-12T12:00" })?.to, undefined);
});

test("audit reset and persisted ISO values can safely initialize local date drafts", () => {
  assert.equal(auditLocalDate(), "");
  assert.equal(auditLocalDate("invalid"), "");
  const local = "2026-11-12T12:00";
  assert.equal(auditLocalDate(new Date(local).toISOString()), local);
});

test("settings compare domains and desktop versions as sets, not formatting or ordering", () => {
  const domains = normalizeAllowedEmailDomainsInput(" @PARTNER.test, example.com\nexample.com ") ?? [];
  assert.equal(settingsDraftChanged(saved, { ...saved, name: " Example workspace ", domains, desktopVersions: ["1.2.4", "1.2.3", "1.2.3"] }, compare), false);
  assert.equal(settingsDraftChanged(saved, { ...saved, desktopVersions: ["1.2.3"] }, compare), true);
  assert.equal(settingsDraftChanged(saved, { ...saved, domains: ["other.test"] }, compare), true);
  assert.equal(settingsDraftChanged(saved, { ...saved, name: "Another workspace" }, compare), true);
});

test("unavailable versions do not create unsaveable dirty state", () => {
  assert.equal(settingsDraftChanged(saved, { ...saved, desktopVersions: [] }, { compareVersions: false }), false);
  const unrestricted = { ...saved, domains: [], domainRestrictionsEnabled: false };
  assert.equal(settingsDraftChanged(unrestricted, { ...unrestricted, domainRestrictionsEnabled: true }, compare), true);
});

test("same-organization refresh preserves edits and updates untouched fields", () => {
  assert.equal(refreshedDraft("My draft", "Saved name", "Refreshed name", true), "My draft");
  assert.equal(refreshedDraft("Saved name", "Saved name", "Refreshed name", true), "Refreshed name");
  assert.deepEqual(refreshedDraft(["1.2.3"], saved.desktopVersions, ["1.2.5"], true, sameStringSet), ["1.2.3"]);
  assert.deepEqual(refreshedDraft(["1.2.4", "1.2.3"], saved.desktopVersions, ["1.2.5"], true, sameStringSet), ["1.2.5"]);
});

test("organization changes and initial loading reset drafts to saved values", () => {
  assert.equal(refreshedDraft("My draft", "Saved name", "Other workspace", false), "Other workspace");
  assert.deepEqual(refreshedDraft(["old-version"], ["saved-version"], ["new-version"], false, sameStringSet), ["new-version"]);
  assert.equal(refreshedDraft("", undefined, "Loaded workspace", true), "Loaded workspace");
});

test("a saved draft becomes clean without overwriting subsequent in-flight edits", () => {
  const submitted = { ...saved, name: "Submitted name" };
  assert.equal(settingsDraftChanged(submitted, submitted, compare), false);
  assert.equal(settingsDraftChanged(submitted, { ...submitted, name: "Newer draft" }, compare), true);
  assert.equal(refreshedDraft("Newer draft", saved.name, submitted.name, true), "Newer draft");
});
