import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { DenOrgSummary } from "./den-org";
import { consumeOrgSelectionRequest, getOrgSelectionMode, requestOrgSelectionOnNextLoad, shouldOpenOrgSelection } from "./org-selection";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function browser() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    } },
  });
  return storage;
}

function organization(id: string, isActive = false): DenOrgSummary {
  return {
    id, isActive, name: id, slug: id, logo: null, metadata: null, role: "member",
    orgMemberId: `member-${id}`, membershipId: `membership-${id}`, memberCount: 2,
    createdAt: null, updatedAt: null,
  };
}

const required = [organization("a"), organization("b")];
const available = [organization("a", true), organization("b")];

test("a required picker consumes the pending handshake instead of reopening on a later refresh", () => {
  const storage = browser();
  requestOrgSelectionOnNextLoad(required);
  assert.equal(storage.size, 1);
  assert.equal(shouldOpenOrgSelection(required), true);
  assert.equal(storage.size, 0);
  assert.equal(shouldOpenOrgSelection(available), false);
});

test("an optional picker opens only once after an explicit post-auth request", () => {
  browser();
  assert.equal(getOrgSelectionMode(available), "available");
  assert.equal(shouldOpenOrgSelection(available), false);
  requestOrgSelectionOnNextLoad(available);
  assert.equal(shouldOpenOrgSelection(available), true);
  assert.equal(shouldOpenOrgSelection(available), false);
});

test("a remembered successful choice can clear the request before dashboard navigation", () => {
  browser();
  requestOrgSelectionOnNextLoad(required);
  assert.equal(consumeOrgSelectionRequest(), true);
  assert.equal(shouldOpenOrgSelection(available), false);
});

test("a single organization consumes an old request without showing a picker", () => {
  const storage = browser();
  requestOrgSelectionOnNextLoad(required);
  assert.equal(shouldOpenOrgSelection([organization("a", true)]), false);
  assert.equal(storage.size, 0);
  assert.equal(shouldOpenOrgSelection(available), false);
});

test("dashboard loads can consume requests even when setup or single-org mode suppresses the picker", () => {
  const storage = browser();
  requestOrgSelectionOnNextLoad(required);
  const requested = consumeOrgSelectionRequest();
  assert.equal(storage.size, 0);
  assert.equal(shouldOpenOrgSelection(available, requested), true);
  assert.equal(shouldOpenOrgSelection(available), false);
});

test("zero or one organization never schedules a request", () => {
  const storage = browser();
  requestOrgSelectionOnNextLoad([]);
  requestOrgSelectionOnNextLoad([organization("a")]);
  assert.equal(storage.size, 0);
  assert.equal(getOrgSelectionMode([]), "none");
  assert.equal(getOrgSelectionMode(required), "required");
});
