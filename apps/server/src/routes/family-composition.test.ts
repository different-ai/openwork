import { describe, expect, test } from "bun:test";

import {
  BUNDLED_SERVER_ROUTE_FAMILY_DESCRIPTORS,
  SERVER_ROUTE_FAMILY_CONTRACT_VERSION,
  composeServerRouteFamilies,
  type ServerRouteFamilyContribution,
} from "./family-composition.js";
import { addRoute, describeRoutes } from "./registry.js";

const ok = async () => new Response(null, { status: 204 });

function contribution(
  id: string,
  order: number,
  register: ServerRouteFamilyContribution["register"],
): ServerRouteFamilyContribution {
  return {
    descriptor: {
      id,
      kind: "server-route-family",
      contractVersion: SERVER_ROUTE_FAMILY_CONTRACT_VERSION,
      provenance: { packageName: `test-${id}` },
      order,
      purpose: `Test ${id}`,
    },
    register,
  };
}

describe("server route-family composition", () => {
  test("keeps the built-in catalog serializable and in legacy family order", () => {
    const descriptors = Object.values(BUNDLED_SERVER_ROUTE_FAMILY_DESCRIPTORS);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "server/routes/core",
      "server/routes/workspaces",
      "server/routes/sessions",
      "server/routes/operations",
      "server/routes/files",
    ]);
    expect(descriptors.map((descriptor) => descriptor.order)).toEqual([
      100,
      200,
      300,
      400,
      500,
    ]);
    expect(JSON.parse(JSON.stringify(descriptors))).toEqual(descriptors);
    expect(descriptors.every((descriptor) => !("register" in descriptor))).toBe(true);
  });

  test("composes exact method/path/auth inventory independent of declaration order", () => {
    const result = composeServerRouteFamilies([
      contribution("test/routes/beta", 200, (routes) => {
        addRoute(routes, "DELETE", "/beta/:id", "client", ok);
      }),
      contribution("test/routes/alpha", 100, (routes) => {
        addRoute(routes, "GET", "/alpha", "none", ok);
        addRoute(routes, "POST", "/alpha/:id", "host", ok);
      }),
    ]);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready composition");
    expect(result.descriptors.map((descriptor) => descriptor.id)).toEqual([
      "test/routes/alpha",
      "test/routes/beta",
    ]);
    expect(result.families.map((family) => family.descriptor.id)).toEqual([
      "test/routes/alpha",
      "test/routes/beta",
    ]);
    expect(describeRoutes(result.families.flatMap((family) => family.routes))).toEqual([
      { method: "GET", path: "/alpha", auth: "none" },
      { method: "POST", path: "/alpha/:id", auth: "host" },
      { method: "DELETE", path: "/beta/:id", auth: "client" },
    ]);
  });

  test("rejects duplicate families before executing registration", () => {
    let registrations = 0;
    const duplicate = contribution("test/routes/duplicate", 100, () => {
      registrations += 1;
    });
    const result = composeServerRouteFamilies([duplicate, duplicate]);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" ? result.diagnostics : []).toEqual([
      expect.objectContaining({
        code: "duplicate-id",
        familyId: "test/routes/duplicate",
      }),
    ]);
    expect(registrations).toBe(0);
  });

  test("isolates registration failures and permits intentional omission", () => {
    const failed = composeServerRouteFamilies([
      contribution("test/routes/failing", 100, (routes) => {
        addRoute(routes, "GET", "/must-not-leak", "host-token", ok);
        throw new Error("fixture failure");
      }),
    ]);

    expect(failed).toMatchObject({
      status: "invalid",
      diagnostics: [{
        code: "family-registration-failed",
        familyId: "test/routes/failing",
        message: "Route family \"test/routes/failing\" failed to register: fixture failure.",
      }],
    });
    expect("families" in failed).toBe(false);

    const omitted = composeServerRouteFamilies([
      contribution("test/routes/only", 100, () => undefined),
    ]);
    expect(omitted.status).toBe("ready");
    expect(omitted.descriptors.map((descriptor) => descriptor.id)).toEqual([
      "test/routes/only",
    ]);
  });
});
