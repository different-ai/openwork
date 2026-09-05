import { describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

describe("Den managed-dashboard capability negotiation", () => {
  test("does not call the new dashboard route when an older Den omits the capability", async () => {
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ capabilities: {} }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    try {
      const dashboards = await createDenClient({ baseUrl: "http://den.local", token: "token" })
        .listGrantedDashboards("organization_1");

      expect(dashboards).toEqual([]);
      expect(paths).toEqual(["/api/den/v1/org"]);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });

  test("calls the dashboard route only after Den explicitly advertises support", async () => {
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return new Response(JSON.stringify(path === "/api/den/v1/org"
        ? { capabilities: { orgManagedDashboards: true } }
        : { items: [] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    try {
      const dashboards = await createDenClient({ baseUrl: "http://den.local", token: "token" })
        .listGrantedDashboards("organization_1");

      expect(dashboards).toEqual([]);
      expect(paths).toEqual(["/api/den/v1/org", "/api/den/v1/me/dashboards"]);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });
});
