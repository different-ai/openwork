import assert from "node:assert/strict";
import { test } from "node:test";
import { APPS_TOOLS_CRUMBS, toolRefPath } from "./apps-tools.ts";
import { MAX_PANEL_DEPTH, pushCrumb, routeDepth, routeKey } from "./panel-route.ts";
import {
  ACTIVITY_CRUMBS,
  ACTIVITY_LEVELS,
  APPS_TOOLS_CRUMB,
  PANEL_VIEWS,
  PANEL_VIEW_TITLES,
  activityRoute,
  activityScreen,
  appsToolsPath,
  appsToolsRoute,
  appsToolsRouteKey,
  isPanelView,
  settingsScreen,
} from "./panel-views.ts";

test("the strip has three icons, in this order, with these names", () => {
  assert.deepEqual(PANEL_VIEWS, ["overview", "memory", "settings"]);
  assert.deepEqual(PANEL_VIEWS.map((view) => PANEL_VIEW_TITLES[view]), ["Activity", "Memory", "Coworker settings"]);
  assert.ok(isPanelView("overview") && isPanelView("memory") && isPanelView("settings"));
  // The old views are gone from the strip; a stale deep link to them is not a view.
  for (const gone of ["documents", "workers", "capabilities", ""]) assert.equal(isPanelView(gone), false, gone);
});

test("Documents, Workers, and Assignments are levels of Activity", () => {
  assert.deepEqual(ACTIVITY_LEVELS, ["documents", "workers", "assignments"]);
  assert.deepEqual(activityScreen([]), { kind: "root" });
  for (const level of ACTIVITY_LEVELS) {
    const route = activityRoute(level);
    assert.equal(route.view, "overview");
    assert.equal(routeDepth(route), 1);
    assert.deepEqual(activityScreen(route.path), { kind: level });
    assert.equal(routeKey(route), `overview/${level}`);
    assert.equal(ACTIVITY_CRUMBS[level].title, level.charAt(0).toUpperCase() + level.slice(1));
  }
  // An unknown first crumb, or one from another view, reads as the root rather than a blank screen.
  assert.deepEqual(activityScreen([{ id: "apps", title: "Apps" }]), { kind: "root" });
});

test("Apps & tools is the first level under Coworker settings and keeps its own levels beneath", () => {
  assert.deepEqual(settingsScreen([]), { kind: "root" });
  assert.deepEqual(settingsScreen([APPS_TOOLS_CRUMB]), { kind: "apps-tools", path: [] });
  const detail = [APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.skills, { id: "skill:create-skill", title: "Create Skill" }];
  const route = appsToolsRoute(detail);
  assert.equal(route.view, "settings");
  assert.deepEqual(route.path, [APPS_TOOLS_CRUMB, ...detail]);
  assert.deepEqual(appsToolsPath(route), detail);
  assert.deepEqual(settingsScreen(route.path), { kind: "apps-tools", path: detail });
  assert.equal(routeKey(route), "settings/apps-tools/connected/skills/skill:create-skill");
  assert.equal(appsToolsRouteKey(detail), routeKey(route));
  // Outside Apps & tools there is no Apps & tools path.
  assert.deepEqual(appsToolsPath({ view: "settings", path: [] }), []);
  assert.deepEqual(appsToolsPath({ view: "overview", path: [ACTIVITY_CRUMBS.workers] }), []);
  assert.deepEqual(settingsScreen([{ id: "model", title: "AI model" }]), { kind: "root" });
});

test("the deepest Apps & tools item still fits under Coworker settings", () => {
  // Coworker settings › Apps & tools › Connected with OpenWork › Skills › Create Skill is four levels.
  const deepest = appsToolsRoute([APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.skills, { id: "skill:create-skill", title: "Create Skill" }]);
  assert.equal(routeDepth(deepest), 4);
  assert.equal(MAX_PANEL_DEPTH, 4);
  assert.deepEqual(appsToolsPath(deepest).map((crumb) => crumb.id), ["connected", "skills", "skill:create-skill"]);
  // Pushing one more replaces the item rather than nesting a fifth level.
  const pushed = pushCrumb(deepest, { id: "skill:other", title: "Other" });
  assert.equal(routeDepth(pushed), 4);
  assert.deepEqual(appsToolsPath(pushed).map((crumb) => crumb.id), ["connected", "skills", "skill:other"]);
  // A receipt's tool opens Apps & tools with its placeholder crumb, as before, now under settings.
  const fromReceipt = appsToolsRoute(toolRefPath("chapter_notes_open_team_pulse", "Team pulse"));
  assert.equal(routeKey(fromReceipt), "settings/apps-tools/tool-ref:chapter_notes_open_team_pulse");
});
