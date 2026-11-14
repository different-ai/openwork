import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { collectFindRanges, findTextMatches, wrappedMatchIndex } = await import("../src/react-app/domains/settings/find/find-matches");

afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

function page(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const found = (ranges: Range[]) => ranges.map((range) => range.toString());
const everythingShown = () => true;

test("matches ignore case and keep the page's own spelling", () => {
  expect(findTextMatches("Workspace run mode. Show workspace run mode", "WORKSPACE")).toEqual([
    { start: 0, end: 9 },
    { start: 25, end: 34 },
  ]);
  expect(findTextMatches("a.b (c)", ".b (")).toEqual([{ start: 1, end: 5 }]);
  expect(findTextMatches("anything", "  ")).toEqual([]);
});

test("every match on the page is found in reading order, however far down it is", () => {
  const root = page(`
    <h3>Runtime</h3>
    <p>The OpenCode engine for this workspace.</p>
    ${"<p>Filler paragraph.</p>".repeat(200)}
    <h4>Chat engine</h4>
    <p>Engine notes.</p>
  `);
  const ranges = collectFindRanges(root, "engine", everythingShown);
  expect(found(ranges)).toEqual(["engine", "engine", "Engine"]);
  expect(ranges[1]?.startContainer.parentElement?.tagName).toBe("H4");
});

test("the page is left untouched", () => {
  const root = page("<p>Developer mode</p><p>Enables the Developer tab.</p>");
  const before = root.innerHTML;
  expect(collectFindRanges(root, "developer", everythingShown)).toHaveLength(2);
  expect(root.innerHTML).toBe(before);
});

test("text nobody can read is not counted", () => {
  const root = page(`
    <p>Keep awake</p>
    <span class="sr-only">Keep awake switch</span>
    <style>.awake { color: red }</style>
    <div data-hidden><p>Awake on another system</p></div>
  `);
  const shown = (element: Element) => !element.closest("[data-hidden]");
  expect(found(collectFindRanges(root, "awake", shown))).toEqual(["awake"]);
});

test("a query shorter than two characters finds nothing", () => {
  const root = page("<p>Appearance</p>");
  expect(collectFindRanges(root, "a", everythingShown)).toEqual([]);
  expect(collectFindRanges(root, " a ", everythingShown)).toEqual([]);
  expect(collectFindRanges(root, "ap", everythingShown)).toHaveLength(1);
});

test("stepping past either end wraps around", () => {
  expect(wrappedMatchIndex(0, 1, 3)).toBe(1);
  expect(wrappedMatchIndex(2, 1, 3)).toBe(0);
  expect(wrappedMatchIndex(0, -1, 3)).toBe(2);
  expect(wrappedMatchIndex(0, 1, 0)).toBe(0);
});
