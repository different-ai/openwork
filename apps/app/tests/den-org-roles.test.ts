import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

describe("Den organization roles", () => {
  test("keeps super-admin organizations in the desktop organization list", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (async () =>
        new Response(JSON.stringify({
          orgs: [{
            id: "org_super",
            name: "Super organization",
            slug: "super-organization",
            role: "super-admin",
          }],
          activeOrgId: "org_super",
          activeOrgSlug: "super-organization",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) satisfies typeof fetch,
    });

    await expect(
      createDenClient({
        baseUrl: "https://den.test",
        token: "tok_test",
      }).listOrgs(),
    ).resolves.toEqual({
      orgs: [{
        id: "org_super",
        name: "Super organization",
        slug: "super-organization",
        role: "super-admin",
      }],
      activeOrgId: "org_super",
      activeOrgSlug: "super-organization",
      defaultOrgId: "org_super",
    });
  });
});
