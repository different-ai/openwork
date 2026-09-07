import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulateSwipe,
  breadcrumbs,
  breadcrumbTrail,
  isBackShortcut,
  MAX_PANEL_DEPTH,
  openPanelRoute,
  parentTitle,
  popCrumb,
  pushCrumb,
  recallRoute,
  rememberRoute,
  replaceCrumb,
  restingSwipe,
  restorePanelRoute,
  rootRoute,
  routeKey,
  sameRoute,
  serializePanelRoute,
  subscribePanelRoute,
  truncateRoute,
  withPath,
  type PanelRoute,
  type PanelRouteMemory,
} from "./panel-route.ts";

// The route rules are generic over the views; the app's own three views live in panel-views.ts.
type View = "overview" | "capabilities" | "memory" | "settings";
const isView = (value: string): value is View => value === "overview" || value === "capabilities" || value === "memory" || value === "settings";

const apps = { id: "apps", title: "Apps" };
const pulse = { id: "app:chapter-notes:open_team_pulse", title: "Team pulse" };
const connected = { id: "connected", title: "Connected with OpenWork" };
const skills = { id: "skills", title: "Skills" };
const createSkill = { id: "skill:create-skill", title: "Create Skill" };

test("push and pop walk one level at a time and never go above the root", () => {
  const root = rootRoute<View>("capabilities");
  const inApps = pushCrumb(root, apps);
  assert.deepEqual(inApps, { view: "capabilities", path: [apps] });
  const detail = pushCrumb(inApps, pulse);
  assert.deepEqual(detail.path, [apps, pulse]);
  assert.deepEqual(popCrumb(detail), inApps);
  assert.deepEqual(popCrumb(root), root);
  // Opening the level already open changes nothing.
  assert.equal(pushCrumb(inApps, apps), inApps);
  // The same level with a fresher title keeps its place.
  assert.deepEqual(pushCrumb(inApps, { id: "apps", title: "Apps (3)" }).path, [{ id: "apps", title: "Apps (3)" }]);
});

test("levels stop at root → level → group → item; a deeper push replaces the item", () => {
  const appsTools = { id: "apps-tools", title: "Apps & tools" };
  const route = withPath(rootRoute<View>("settings"), [appsTools, connected, skills, createSkill]);
  assert.equal(MAX_PANEL_DEPTH, 4);
  assert.equal(route.path.length, MAX_PANEL_DEPTH);
  const deeper = pushCrumb(route, { id: "skill:another", title: "Another" });
  assert.equal(deeper.path.length, MAX_PANEL_DEPTH);
  assert.deepEqual(deeper.path.map((crumb) => crumb.id), ["apps-tools", "connected", "skills", "skill:another"]);
  assert.equal(withPath(route, [appsTools, connected, skills, createSkill, { id: "x", title: "X" }]).path.length, MAX_PANEL_DEPTH);
});

test("replace swaps a sibling in place and truncate jumps up the trail", () => {
  const route = withPath(rootRoute<View>("capabilities"), [apps, pulse]);
  assert.deepEqual(replaceCrumb(route, { id: "app:other", title: "Other" }).path, [apps, { id: "app:other", title: "Other" }]);
  assert.deepEqual(replaceCrumb(rootRoute<View>("capabilities"), apps).path, [apps]);
  assert.deepEqual(truncateRoute(route, 1), { view: "capabilities", path: [apps] });
  assert.deepEqual(truncateRoute(route, 0), rootRoute("capabilities"));
  assert.equal(truncateRoute(route, 5), route);
  assert.equal(truncateRoute(route, -1).path.length, 0);
});

test("route keys tell levels apart and compare routes", () => {
  const a = withPath(rootRoute<View>("capabilities"), [apps, pulse]);
  const b = withPath(rootRoute<View>("capabilities"), [apps, pulse]);
  assert.equal(routeKey(a), "capabilities/apps/app:chapter-notes:open_team_pulse");
  assert.equal(routeKey(rootRoute("overview")), "overview");
  assert.ok(sameRoute(a, b));
  assert.ok(!sameRoute(a, popCrumb(a)));
});

test("breadcrumbs show every level when there is room and collapse the middle when narrow", () => {
  const route = withPath(rootRoute<View>("capabilities"), [connected, skills, createSkill]);
  const trail = breadcrumbTrail(route, "Apps & tools");
  assert.deepEqual(trail.map((crumb) => [crumb.depth, crumb.title, crumb.current]), [
    [0, "Apps & tools", false],
    [1, "Connected with OpenWork", false],
    [2, "Skills", false],
    [3, "Create Skill", true],
  ]);
  const wide = breadcrumbs(route, "Apps & tools", { width: 440 });
  assert.equal(wide.visible.length, 4);
  assert.equal(wide.skipped.length, 0);
  // Under 380 px only the root and the current level stay; the rest moves to the menu.
  const narrow = breadcrumbs(route, "Apps & tools", { width: 320 });
  assert.deepEqual(narrow.visible.map((crumb) => crumb.title), ["Apps & tools", "Create Skill"]);
  assert.deepEqual(narrow.skipped.map((crumb) => crumb.title), ["Connected with OpenWork", "Skills"]);
  // At the root nothing collapses, whatever the width.
  assert.deepEqual(breadcrumbs(rootRoute("capabilities"), "Apps & tools", { width: 320 }).skipped, []);
  // The threshold is inclusive of 380.
  assert.equal(breadcrumbs(route, "Apps & tools", { width: 380 }).skipped.length, 0);
  assert.equal(breadcrumbs(route, "Apps & tools", { width: 379 }).skipped.length, 2);
});

test("the back control names the parent level", () => {
  assert.equal(parentTitle(rootRoute("capabilities"), "Apps & tools"), null);
  assert.equal(parentTitle(withPath(rootRoute<View>("capabilities"), [apps]), "Apps & tools"), "Apps & tools");
  assert.equal(parentTitle(withPath(rootRoute<View>("capabilities"), [apps, pulse]), "Apps & tools"), "Apps");
});

test("routes serialize and restore, and reject unknown views or malformed paths", () => {
  const route = withPath(rootRoute<View>("capabilities"), [apps, pulse]);
  const restored = restorePanelRoute(serializePanelRoute(route), isView);
  assert.deepEqual(restored, route);
  assert.equal(restorePanelRoute(JSON.stringify({ view: "documents", path: [] }), isView), null);
  assert.equal(restorePanelRoute(JSON.stringify({ view: "memory", path: [{ id: 1 }] }), isView), null);
  assert.equal(restorePanelRoute("not json", isView), null);
  assert.equal(restorePanelRoute(null, isView), null);
  const deep = JSON.stringify({ view: "capabilities", path: [apps, pulse, skills, createSkill, { id: "x", title: "X" }] });
  assert.equal(restorePanelRoute(deep, isView)?.path.length, MAX_PANEL_DEPTH);
});

test("each view remembers its last route for the session", () => {
  let memory: PanelRouteMemory<View> = {};
  const detail = withPath(rootRoute<View>("capabilities"), [apps, pulse]);
  memory = rememberRoute(memory, detail);
  memory = rememberRoute(memory, rootRoute("memory"));
  assert.deepEqual(recallRoute(memory, "capabilities"), detail);
  assert.deepEqual(recallRoute(memory, "overview"), rootRoute("overview"));
  // Remembering the same route again keeps the same object.
  assert.equal(rememberRoute(memory, detail), memory);
});

test("a two-finger swipe right fires once past the threshold and settles before it can fire again", () => {
  let state = restingSwipe;
  let fired = 0;
  const feed = (deltaX: number, at: number, deltaY = 0) => {
    const next = accumulateSwipe(state, { deltaX, deltaY, at });
    state = next.state;
    if (next.back) fired += 1;
  };
  feed(-30, 1000);
  feed(-30, 1016);
  assert.equal(fired, 0);
  feed(-30, 1032);
  assert.equal(fired, 1);
  // More travel in the same gesture does not fire again.
  feed(-60, 1048);
  assert.equal(fired, 1);
  // After the fingers settle, a new gesture can fire.
  feed(-90, 1400);
  assert.equal(fired, 2);
  // Scrolling (mostly vertical) never counts, and a swipe left never fires.
  let scroll = restingSwipe;
  assert.equal(accumulateSwipe(scroll, { deltaX: -100, deltaY: 300, at: 1 }).back, false);
  scroll = accumulateSwipe(scroll, { deltaX: 100, deltaY: 0, at: 2 }).state;
  assert.equal(accumulateSwipe(scroll, { deltaX: 100, deltaY: 0, at: 3 }).back, false);
});

test("back shortcuts are ⌘[ and Alt+←, nothing else", () => {
  const key = (overrides: Partial<{ key: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({
    key: "", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...overrides,
  });
  assert.ok(isBackShortcut(key({ key: "[", metaKey: true })));
  assert.ok(isBackShortcut(key({ key: "ArrowLeft", altKey: true })));
  assert.ok(!isBackShortcut(key({ key: "[", metaKey: true, shiftKey: true })));
  assert.ok(!isBackShortcut(key({ key: "ArrowLeft" })));
  assert.ok(!isBackShortcut(key({ key: "[", ctrlKey: true })));
  assert.ok(!isBackShortcut(key({ key: "ArrowLeft", altKey: true, metaKey: true })));
});

test("deep links reach a mounted panel and report when nobody is listening", () => {
  const route: PanelRoute = withPath(rootRoute("capabilities"), [apps, pulse]);
  assert.equal(openPanelRoute(route), false);
  const seen: PanelRoute[] = [];
  const unsubscribe = subscribePanelRoute((next) => seen.push(next));
  assert.equal(openPanelRoute(route), true);
  assert.deepEqual(seen, [route]);
  unsubscribe();
  assert.equal(openPanelRoute(route), false);
});
