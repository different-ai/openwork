import { afterEach, describe, expect, test } from "bun:test";

import {
  createDenClient,
  formatDenOrgRoleLabel,
  getDenCanonicalOrgRole,
  isDenOrgAdminRole,
} from "../src/app/lib/den";

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

  test("keeps custom and combined roles without collapsing their role strings", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (async () =>
        new Response(JSON.stringify({
          orgs: [
            {
              id: "org_custom",
              name: "Custom organization",
              slug: "custom-organization",
              role: "qa-reviewer",
            },
            {
              id: "org_combined",
              name: "Combined organization",
              slug: "combined-organization",
              role: "qa-reviewer, super-admin",
            },
          ],
          activeOrgId: "org_custom",
          activeOrgSlug: "custom-organization",
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
    ).resolves.toMatchObject({
      orgs: [
        { id: "org_custom", role: "qa-reviewer" },
        { id: "org_combined", role: "qa-reviewer, super-admin" },
      ],
    });
  });

  test("derives built-in access while preserving custom role labels", () => {
    expect(getDenCanonicalOrgRole("qa-reviewer")).toBe("member");
    expect(getDenCanonicalOrgRole("admin, qa-reviewer")).toBe("admin");
    expect(getDenCanonicalOrgRole("qa-reviewer, super_admin")).toBe("super-admin");
    expect(isDenOrgAdminRole("qa-reviewer")).toBe(false);
    expect(isDenOrgAdminRole("qa-reviewer, super-admin")).toBe(true);
    expect(formatDenOrgRoleLabel("qa-reviewer, super-admin")).toBe("Qa Reviewer, Super admin");
  });
});
