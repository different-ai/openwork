import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { acquireHostedSandboxResources, sandboxStartupFixture, type StartupLoad } from "../worlds/mcp-app-sandbox-startup";

function expectExactlyOneDeliveryPerTile(load: StartupLoad) {
  expect(load.delivered).toBe(load.tiles);
  expect(load.initialized).toBe(load.tiles);
  expect(load.statuses).toEqual([]);
  for (let index = 0; index < load.tiles; index += 1) {
    const tile = String(index);
    const events = load.events.filter((event) => event.tile === tile);
    expect(events.filter((event) => event.kind === "ui/notifications/initialized")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "fixture/result-received").map((event) => event.detail)).toEqual([
      { text: `fixture-result-${tile}`, arguments: { tile, request: "fixture-launch" } },
    ]);
    const methods = events.map((event) => event.kind);
    expect(methods).toContain("ui/notifications/sandbox-proxy-ready");
    expect(methods).toContain("ui/notifications/sandbox-resource-accepted");
    expect(methods.indexOf("ui/notifications/sandbox-resource-accepted")).toBeLessThan(methods.indexOf("ui/initialize"));
    expect(methods.indexOf("ui/notifications/initialized")).toBeLessThan(methods.indexOf("fixture/result-received"));
  }
}

test("sandbox component integration: immediate proxy ready across ten one-tile and six-tile loads", async ({ evidence }) => {
  await using fixture = await sandboxStartupFixture();
  for (const tiles of [1, 6]) {
    const loads = [];
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const load = await fixture.load({ name: `baseline-${tiles}-${iteration}`, tiles });
      loads.push(load);
      expectExactlyOneDeliveryPerTile(load);
      expect(load.errors).toBe(0);
    }
    evidence.recordAssertionEvidence(`Ten ${tiles}-tile component loads`, JSON.stringify({ traces: fixture.resultsDir, loads: loads.length, delivered: loads.reduce((sum, load) => sum + load.delivered, 0), errors: loads.reduce((sum, load) => sum + load.errors, 0) }), loads.every((load) => load.delivered === tiles && load.errors === 0));
  }
});

test("sandbox component integration: inline proxy ignores external CSS and script response delays", async ({ evidence }) => {
  await using fixture = await sandboxStartupFixture();
  for (const dependency of ["css", "script", "both"]) {
    const load = await fixture.load({
      name: `inline-${dependency}-6`,
      tiles: 6,
      cssDelayMs: dependency === "script" ? 0 : 11_000,
      scriptDelayMs: dependency === "css" ? 0 : 11_000,
    });
    expectExactlyOneDeliveryPerTile(load);
    expect(load.errors).toBe(0);
    expect(load.requests.filter((request) => request.path.endsWith(".css") || request.path.endsWith(".js"))).toEqual([]);
    expect(load.requests.filter((request) => request.path.endsWith(".html") && request.phase === "finish")).toHaveLength(6);
    evidence.recordAssertionEvidence(`Inline bootstrap has no ${dependency} request dependency`, JSON.stringify({ traces: fixture.resultsDir, name: load.name, delivered: load.delivered, elapsedMs: load.elapsedMs }), load.delivered === 6 && load.errors === 0);
  }
});

test("sandbox component integration: HTML timeout Retry recovers only the failed tile without duplicate results", async ({ evidence }) => {
  await using fixture = await sandboxStartupFixture();
  for (const tiles of [1, 6]) {
    const failed = await fixture.load({ name: `html-timeout-${tiles}`, tiles, documentDelayMs: 11_000, delayedDocumentNumber: 1 });
    expect(failed.errors).toBe(1);
    expect(failed.delivered).toBe(tiles - 1);
    expect(failed.initialized).toBe(tiles - 1);
    expect(failed.statuses).toHaveLength(1);
    expect(failed.statuses[0]).toContain("MCP_APP_SANDBOX_PROXY_TIMEOUT");
    const failures = failed.events.filter((event) => event.kind === "view-error");
    expect(failures).toHaveLength(1);
    const tile = failures[0].tile;
    expect(failed.retryTiles).toEqual([tile]);
    const failedEvents = failed.events.filter((event) => event.tile === tile);
    expect(failedEvents.filter((event) => event.kind === "ui/notifications/sandbox-proxy-ready" || event.kind === "ui/notifications/sandbox-resource-accepted" || event.kind === "ui/initialize")).toEqual([]);
    const navigation = failedEvents.find((event) => event.kind === "navigation-assigned");
    expect(navigation).toBeDefined();
    if (!navigation) throw new Error("Failed tile navigation trace missing");
    expect(failures[0].at - navigation.at).toBeGreaterThanOrEqual(9_500);
    const recovered = await fixture.retry({ name: `html-retry-${tiles}`, tile, tiles });
    expectExactlyOneDeliveryPerTile(recovered);
    expect(recovered.errors).toBe(1);
    expect(recovered.retryTiles).toEqual([]);
    expect(recovered.events.filter((event) => event.kind === "retry-click").map((event) => ({ tile: event.tile, detail: event.detail }))).toEqual([{ tile, detail: { trusted: true } }]);
    expect(recovered.events.filter((event) => event.tile === tile && event.kind === "navigation-assigned")).toHaveLength(2);
    for (let index = 0; index < tiles; index += 1) {
      const sibling = String(index);
      if (sibling === tile) continue;
      expect(recovered.events.filter((event) => event.tile === sibling)).toEqual(failed.events.filter((event) => event.tile === sibling));
    }
    expect(recovered.requests.filter((request) => request.path.endsWith(".html") && request.phase === "request")).toHaveLength(tiles + 1);
    expect(recovered.requests.filter((request) => request.path.endsWith(".html") && request.phase === "finish")).toHaveLength(tiles);
    expect(recovered.requests.filter((request) => request.path.endsWith(".css") || request.path.endsWith(".js"))).toEqual([]);
    evidence.recordAssertionEvidence(`HTML timeout and real Retry (${tiles} tiles)`, JSON.stringify({ traces: fixture.resultsDir, failedTile: tile, delivered: recovered.delivered, historicalErrors: recovered.errors, duplicateObservationMs: 2_000 }), recovered.delivered === tiles && recovered.errors === 1 && recovered.statuses.length === 0);
  }
});

const hostedEndpoints = process.env.OPENWORK_SANDBOX_DEMO_ENDPOINTS;
if (hostedEndpoints) {
  test("sandbox component integration: opt-in hosted demo matrix with anonymous readiness traces", async ({ evidence }) => {
    const resources = await acquireHostedSandboxResources(hostedEndpoints);
    expect(resources.map((resource) => resource.label)).toEqual(["provider-1", "provider-2", "provider-3"]);
    await using fixture = await sandboxStartupFixture(resources);
    for (const tiles of [1, 6]) {
      const loads = [];
      for (let iteration = 0; iteration < 12; iteration += 1) {
        const offset = iteration % resources.length;
        const load = await fixture.load({ name: `hosted-${tiles}-${iteration}`, tiles, providerOffset: offset });
        loads.push(load);
        expect(load.errors).toBe(0);
        expect(load.statuses).toEqual([]);
        expect(load.initialized).toBe(tiles);
        expect(load.delivered).toBe(tiles);
        for (let index = 0; index < tiles; index += 1) {
          const kinds = load.events.filter((event) => event.tile === String(index)).map((event) => event.kind);
          expect(kinds.filter((kind) => kind === "ui/notifications/sandbox-resource-accepted")).toHaveLength(1);
          expect(kinds.filter((kind) => kind === "ui/notifications/initialized")).toHaveLength(1);
          expect(kinds.filter((kind) => kind === "hosted-input-received")).toHaveLength(1);
          expect(kinds.filter((kind) => kind === "hosted-result-received")).toHaveLength(1);
          expect(kinds).not.toContain("hosted-delivery-mismatch");
        }
        expect(load.events.every((event) => event.detail === null)).toBe(true);
      }
      evidence.recordAssertionEvidence(`Hosted read-only component matrix: 12 ${tiles}-tile loads`, JSON.stringify({ traces: fixture.resultsDir, providers: resources.map((resource) => resource.label), loads: loads.length, initialized: loads.reduce((sum, load) => sum + load.initialized, 0), delivered: loads.reduce((sum, load) => sum + load.delivered, 0) }), loads.every((load) => load.errors === 0 && load.delivered === tiles));
    }
  });
}
