import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { DenOrgSummary } from "./den-org";
import { readRememberedOrganization, rememberOrganization, restoreRememberedOrganization, setActiveOrganizationAndRemember } from "./org-memory";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();

afterEach(() => {
  storage.clear();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function browser(origin = "https://den.example", blocked = false) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: new URL(origin),
      localStorage: {
        getItem(key: string) {
          if (blocked) throw new Error("Storage blocked");
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          if (blocked) throw new Error("Storage blocked");
          storage.set(key, value);
        },
      },
    },
  });
}

function organization(id: string, isActive = false): DenOrgSummary {
  return {
    id, isActive, name: id, slug: id, logo: null, metadata: null, role: "member",
    orgMemberId: `member-${id}`, membershipId: `membership-${id}`, memberCount: 2,
    createdAt: null, updatedAt: null,
  };
}

function context(id: string, userId = "account-a") {
  return {
    organization: { id }, currentMember: { userId },
  };
}

function fixture() {
  browser();
  rememberOrganization("account-a", "org-b");
  const calls: string[] = [];
  const input: Parameters<typeof restoreRememberedOrganization>[0] = {
    userId: "account-a",
    // A server default is not the member's remembered choice.
    organizations: [organization("org-a", true), organization("org-b")],
    isCurrent: () => true,
    loadContext: async (id) => { calls.push(`context:${id}`); return context(id); },
    setActive: async (id) => { calls.push(`active:${id}`); },
  };
  return { input, calls };
}

test("the durable preference stores only the chosen ID, scoped to the verified account and server", () => {
  browser();
  rememberOrganization("account-a", " org-b ");
  assert.deepEqual([...storage], [[
    'openwork.den.lastOrganization:["https://den.example","account-a"]', "org-b",
  ]]);
  assert.equal(readRememberedOrganization("account-a"), "org-b");
  assert.equal(readRememberedOrganization("account-b"), null);
  browser("https://other-den.example");
  assert.equal(readRememberedOrganization("account-a"), null);
  browser();
  assert.equal(readRememberedOrganization("account-a"), "org-b");
});

test("blank identities, blank choices, SSR and blocked storage never prevent sign-in", () => {
  Reflect.deleteProperty(globalThis, "window");
  rememberOrganization("account-a", "org-b");
  assert.equal(readRememberedOrganization("account-a"), null);
  browser();
  rememberOrganization(" ", "org-b");
  rememberOrganization("account-a", " ");
  assert.equal(storage.size, 0);
  browser("https://den.example", true);
  assert.doesNotThrow(() => rememberOrganization("account-a", "org-b"));
  assert.equal(readRememberedOrganization("account-a"), null);
});

test("a live member restores B rather than the server's first/default A", async () => {
  const { input, calls } = fixture();
  assert.equal((await restoreRememberedOrganization(input))?.id, "org-b");
  assert.deepEqual(calls, ["context:org-b", "active:org-b"]);
});

test("another account never inherits the previous account's preference or guesses its first org", async () => {
  const { input, calls } = fixture();
  input.userId = "account-b";
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, []);
  assert.equal(readRememberedOrganization("account-b"), null);
});

test("a removed or malformed stored ID never leaves the browser", async () => {
  const { input, calls } = fixture();
  for (const id of ["removed-org", '{"organizationId":"org-b"}', ""]) {
    storage.set('openwork.den.lastOrganization:["https://den.example","account-a"]', id);
    assert.equal(await restoreRememberedOrganization(input), null);
  }
  assert.deepEqual(calls, []);
});

test("a missing context, wrong workspace, or wrong authenticated identity keeps the chooser", async () => {
  const { input, calls } = fixture();
  for (const result of [null, context("org-a"), context("org-b", "account-b")]) {
    input.loadContext = async (id) => { calls.push(`context:${id}`); return result; };
    assert.equal(await restoreRememberedOrganization(input), null);
    assert.equal(readRememberedOrganization("account-a"), "org-b");
  }
  assert.deepEqual(calls, Array(3).fill("context:org-b"));
});

test("a context fetch failure stays in the chooser without losing the durable preference", async () => {
  const { input, calls } = fixture();
  input.loadContext = async () => { throw new Error("offline"); };
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, []);
  assert.equal(readRememberedOrganization("account-a"), "org-b");
});

test("a rejected active-organization acknowledgement stays in the chooser", async () => {
  const { input, calls } = fixture();
  input.setActive = async (id) => { calls.push(`rejected:${id}`); throw new Error("membership revoked"); };
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, ["context:org-b", "rejected:org-b"]);
  assert.equal(readRememberedOrganization("account-a"), "org-b");
});

test("every restoration checks live identity instead of caching a previous result", async () => {
  const { input, calls } = fixture();
  let userId = "account-a";
  input.loadContext = async (id) => { calls.push(`context:${id}`); return context(id, userId); };
  assert.equal((await restoreRememberedOrganization(input))?.id, "org-b");
  userId = "account-b";
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, ["context:org-b", "active:org-b", "context:org-b"]);
});

test("membership removed since a previous successful restore is not reused", async () => {
  const { input, calls } = fixture();
  assert.equal((await restoreRememberedOrganization(input))?.id, "org-b");
  input.organizations = [organization("org-a", true), organization("org-c")];
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, ["context:org-b", "active:org-b"]);
});

test("blocked preference storage falls back without any organization request", async () => {
  const { input, calls } = fixture();
  browser("https://den.example", true);
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, []);
});

test("an already stale account or generation sends no requests", async () => {
  const { input, calls } = fixture();
  input.isCurrent = () => false;
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, []);
});

test("an explicit switch or account change during membership validation wins over memory", async () => {
  const { input, calls } = fixture();
  let current = true;
  input.isCurrent = () => current;
  input.loadContext = async (id) => { calls.push(`context:${id}`); current = false; return context(id); };
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, ["context:org-b"]);
});

test("a late server acknowledgement cannot publish a stale restored organization", async () => {
  const { input, calls } = fixture();
  let current = true;
  input.isCurrent = () => current;
  input.setActive = async (id) => { calls.push(`active:${id}`); current = false; };
  assert.equal(await restoreRememberedOrganization(input), null);
  assert.deepEqual(calls, ["context:org-b", "active:org-b"]);
});

test("an acknowledged explicit choice is saved before any details request can fail or stall", async () => {
  browser();
  rememberOrganization("account-a", "org-b");
  const acknowledged = await setActiveOrganizationAndRemember({
    userId: "account-a", organizationId: "org-c", isCurrent: () => true,
    setActive: async () => {
      assert.equal(readRememberedOrganization("account-a"), "org-b");
    },
  });
  assert.equal(acknowledged, true);
  assert.equal(readRememberedOrganization("account-a"), "org-c");
});

test("a failed explicit switch keeps the previously acknowledged choice", async () => {
  browser();
  rememberOrganization("account-a", "org-b");
  await assert.rejects(setActiveOrganizationAndRemember({
    userId: "account-a", organizationId: "org-c", isCurrent: () => true,
    setActive: async () => { throw new Error("switch rejected"); },
  }), /switch rejected/);
  assert.equal(readRememberedOrganization("account-a"), "org-b");
});

test("an explicit switch invalidated before acknowledgement never overwrites a newer choice", async () => {
  browser();
  let current = true;
  const acknowledged = await setActiveOrganizationAndRemember({
    userId: "account-a", organizationId: "org-b", isCurrent: () => current,
    setActive: async () => {
      rememberOrganization("account-a", "org-c");
      current = false;
    },
  });
  assert.equal(acknowledged, false);
  assert.equal(readRememberedOrganization("account-a"), "org-c");
  assert.equal(readRememberedOrganization("account-b"), null);
});

test("an already invalidated explicit switch sends no request and saves nothing", async () => {
  browser();
  let requests = 0;
  const acknowledged = await setActiveOrganizationAndRemember({
    userId: "account-a", organizationId: "org-b", isCurrent: () => false,
    setActive: async () => { requests += 1; },
  });
  assert.equal(acknowledged, false);
  assert.equal(requests, 0);
  assert.equal(storage.size, 0);
});
