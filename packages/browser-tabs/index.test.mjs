import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_VIEWPORTS,
  BACKGROUND_TAB_VIEWPORT,
  agentViewportEmulationCommands,
  agentViewportFor,
  fitAgentViewport,
} from "./index.mjs";

test("an agent viewport scales down to fit the panel, centered at the top, and never up", () => {
  const desktop = AGENT_VIEWPORTS.desktop;
  assert.deepEqual(fitAgentViewport(desktop, { x: 900, y: 80, width: 640, height: 900 }),
    { scale: 0.5, bounds: { x: 900, y: 80, width: 640, height: 400 } });
  const phone = fitAgentViewport(AGENT_VIEWPORTS.phone, { x: 0, y: 0, width: 600, height: 422 });
  assert.equal(phone.scale, 0.5);
  assert.deepEqual(phone.bounds, { x: 202, y: 0, width: 195, height: 422 });
  assert.deepEqual(fitAgentViewport(desktop, { x: 10, y: 20, width: 1600, height: 1000 }),
    { scale: 1, bounds: { x: 170, y: 20, width: 1280, height: 800 } });
});

test("the desktop agent size matches background tabs, and unknown sizes fall back to it", () => {
  assert.deepEqual([AGENT_VIEWPORTS.desktop.width, AGENT_VIEWPORTS.desktop.height], [BACKGROUND_TAB_VIEWPORT.width, BACKGROUND_TAB_VIEWPORT.height]);
  assert.equal(agentViewportFor("watch"), AGENT_VIEWPORTS.desktop);
  assert.equal(agentViewportFor("toString"), AGENT_VIEWPORTS.desktop);
  assert.equal(agentViewportFor("tablet"), AGENT_VIEWPORTS.tablet);
});

test("emulation keeps the native view's size and only a phone gets touch and a mobile user agent", () => {
  const [metrics, touch, agent] = agentViewportEmulationCommands(AGENT_VIEWPORTS.phone, 0.4, "142.0.7444.59");
  assert.deepEqual(metrics.params, { width: 390, height: 844, deviceScaleFactor: 0, mobile: true, scale: 0.4, dontSetVisibleSize: true });
  assert.deepEqual(touch.params, { enabled: true, maxTouchPoints: 5 });
  assert.match(agent.params.userAgent, /Android .* Chrome\/142\.0\.0\.0 Mobile Safari/);
  assert.equal(agent.params.userAgentMetadata.mobile, true);
  const desktop = agentViewportEmulationCommands(AGENT_VIEWPORTS.desktop, 1, "142.0.7444.59");
  assert.deepEqual(desktop.map(command => command.params), [
    { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false, scale: 1, dontSetVisibleSize: true },
    { enabled: false },
    { userAgent: "" },
  ]);
});
