import { describe, expect, test } from "bun:test";

import { addRoute, matchRoute, type Route } from "./registry.js";

const handler: Route["handler"] = async () => new Response(null);

describe("route registry", () => {
  test("decodes valid route params", () => {
    const routes: Route[] = [];
    addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", handler);

    const route = matchRoute(routes, "GET", "/workspace/ws_1/skills/my%20skill");

    expect(route?.params).toEqual({ id: "ws_1", name: "my skill" });
  });

  test("rejects malformed percent-encoded params without throwing", () => {
    const routes: Route[] = [];
    addRoute(routes, "GET", "/workspace/:id", "client", handler);

    expect(() => matchRoute(routes, "GET", "/workspace/%E0%A4%A")).not.toThrow();
    expect(matchRoute(routes, "GET", "/workspace/%E0%A4%A")).toBeNull();
  });
});
