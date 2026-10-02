import { expect, test } from "bun:test";
import { createDenClient } from "../src/app/lib/den";
import { createActivityStore, selectActivityContext } from "../src/react-app/kernel/activity-store";
import { refreshMemberActivity } from "../src/react-app/domains/cloud/member-activity-sync";

test("malformed and unsupported inventory responses cannot become access removals", async () => {
  let mode: "empty" | "available" | "malformed-list" | "malformed-row" | "unsupported" = "empty";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/llm-providers")) {
        if (mode === "malformed-list") return Response.json({ llmProviders: null });
        if (mode === "malformed-row") return Response.json({ llmProviders: [{ name: "Incomplete provider" }] });
        return Response.json({ llmProviders: mode === "empty" ? [] : [{
          id: "provider-278", providerId: "team-model", name: "Team model", source: "custom", models: [],
        }] });
      }
      if (path.endsWith("/inference-providers")) {
        return mode === "unsupported" ? Response.json({}, { status: 404 }) : Response.json({ inferenceProviders: [] });
      }
      if (path.endsWith("/mcp-connections")) return Response.json({ connections: [] });
      if (path.endsWith("/marketplace-capabilities") || path.endsWith("/me/library")) return Response.json({ items: [] });
      return Response.json({}, { status: 404 });
    },
  });
  try {
    const baseUrl = server.url.origin;
    const scope = { baseUrl, organizationId: "org-278", memberId: "member-278" };
    const client = createDenClient({ baseUrl, apiBaseUrl: baseUrl, token: "eng-278-fixture", requireCompleteInventory: true });
    const store = createActivityStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    store.getState().setScope(scope);
    const refresh = () => refreshMemberActivity({ scope, client, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    mode = "available";
    expect(await refresh()).toBe("updated");
    const good = selectActivityContext(store.getState());
    expect(good.entries.map((entry) => entry.resource.label)).toEqual(["Team model"]);
    mode = "malformed-list";
    expect(await refresh()).toBe("failed");
    expect(selectActivityContext(store.getState())).toEqual(good);
    mode = "malformed-row";
    expect(await refresh()).toBe("failed");
    expect(selectActivityContext(store.getState())).toEqual(good);
    mode = "unsupported";
    expect(await refresh()).toBe("failed");
    expect(selectActivityContext(store.getState())).toEqual(good);
    expect(store.getState().refreshState).toBe("error");
  } finally {
    server.stop(true);
  }
});

test("Den object types the app does not model (MCP Apps) are outside the inventory, not proof it is incomplete", async () => {
  let rows: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/llm-providers")) return Response.json({ llmProviders: [] });
      if (path.endsWith("/inference-providers")) return Response.json({ inferenceProviders: [] });
      if (path.endsWith("/mcp-connections")) return Response.json({ connections: [] });
      if (path.endsWith("/marketplace-capabilities")) return Response.json({ items: rows });
      if (path.endsWith("/me/library")) return Response.json({ items: [] });
      return Response.json({}, { status: 404 });
    },
  });
  try {
    const baseUrl = server.url.origin;
    const client = createDenClient({ baseUrl, apiBaseUrl: baseUrl, token: "eng-278-fixture", requireCompleteInventory: true });
    rows = [{ configObjectId: "app-1", marketplaceId: null, objectType: "app", pluginId: "plugin-1" }];
    expect(await client.listAssignedMarketplaceCapabilities("org-278")).toEqual([]);
    // A row of a modeled type that cannot be parsed still fails verification.
    rows = [...rows, { configObjectId: 42, marketplaceId: null, objectType: "skill", pluginId: "plugin-1" }];
    await expect(client.listAssignedMarketplaceCapabilities("org-278")).rejects.toThrow("could not be verified");
  } finally {
    server.stop(true);
  }
});
