import { afterEach, expect, test, vi } from "vitest";
import { checkContrast, checkOverlap } from "./geometry.ts";
import { collectLayout } from "./layout.ts";

// Unit doubles deliberately return cached rects for unpainted nodes. The E2E
// world is the authority for native Chromium visibility and line fragmentation.
function rect(x: number, y: number, width: number, height = 16) {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}
type FixtureRect = ReturnType<typeof rect>;

class FixtureElement {
  children: FixtureElement[] = [];
  attributes: Record<string, string> = {};
  ownerDocument: { documentElement: FixtureElement | null } = { documentElement: null };
  rect = rect(0, 0, 800, 600);
  painted = true;
  checkVisibility: ((options: { contentVisibilityAuto: boolean }) => boolean) | undefined = vi.fn(() => this.painted);
  style = {
    display: "block", visibility: "visible", opacity: "1", backgroundColor: "rgba(0, 0, 0, 0)",
    overflowX: "visible", overflowY: "visible", color: "rgb(17, 24, 39)", fontSize: "13px", fontWeight: "400",
  };
  tagName: string;
  parentElement: FixtureElement | null;
  constructor(tagName = "SPAN", parentElement: FixtureElement | null = null) {
    this.tagName = tagName;
    this.parentElement = parentElement;
    parentElement?.children.push(this);
  }
  contains(element: FixtureElement): boolean {
    for (let current: FixtureElement | null = element; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
  matches(selector: string): boolean {
    return selector === "details:not([open])" && this.tagName === "DETAILS" && !this.hasAttribute("open");
  }
  closest(selector: string): FixtureElement | null {
    for (let current: FixtureElement | null = this; current; current = current.parentElement) {
      if (selector === "[disabled], [aria-disabled=true]") {
        if (current.hasAttribute("disabled") || current.getAttribute("aria-disabled") === "true") return current;
      } else if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"].includes(current.tagName)) return current;
    }
    return null;
  }
  getBoundingClientRect() { return this.rect; }
  getAttributeNames() { return Object.keys(this.attributes); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
}

interface FixtureText { textContent: string; parentElement: FixtureElement; rects: FixtureRect[] }
const text = (textContent: string, parentElement = new FixtureElement(), rects = [rect(20, 20, 100)]): FixtureText => ({ textContent, parentElement, rects });

function page(nodes: FixtureText[], options: { media?: FixtureElement[]; hit?: (x: number, y: number) => FixtureElement | null } = {}) {
  const root = new FixtureElement("HTML");
  const body = new FixtureElement("BODY", root);
  const ownerDocument = { documentElement: root };
  root.ownerDocument = body.ownerDocument = ownerDocument;
  for (const element of [...nodes.map((node) => node.parentElement), ...(options.media ?? [])]) {
    for (let current: FixtureElement | null = element; current && current !== body; current = current.parentElement) {
      current.ownerDocument = ownerDocument;
      if (!current.parentElement) { current.parentElement = body; body.children.push(current); }
    }
  }
  let index = 0;
  const unionRect = vi.fn(() => { throw new Error("A whole-node union is not a painted line."); });
  const paint = {
    fillStyle: "rgba(0, 0, 0, 0)",
    clearRect() {}, fillRect() {},
    getImageData() {
      const channels = this.fillStyle.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return { data: new Uint8ClampedArray([channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, (channels[3] ?? 1) * 255]) };
    },
  };
  vi.stubGlobal("document", {
    body,
    documentElement: Object.assign(root, { clientWidth: 800, scrollWidth: 800, scrollHeight: 600 }),
    createTreeWalker: () => ({ nextNode: () => nodes[index++] ?? null }),
    createRange: () => {
      let selected: FixtureText | undefined;
      return {
        selectNodeContents: (node: FixtureText) => { selected = node; },
        getClientRects: () => selected?.rects ?? [],
        getBoundingClientRect: unionRect,
      };
    },
    createElement: () => ({ width: 0, height: 0, getContext: () => paint }),
    elementFromPoint: options.hit ?? (() => body),
    querySelectorAll: () => options.media ?? [],
  });
  vi.stubGlobal("window", { innerHeight: 600 });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("getComputedStyle", (element: FixtureElement) => element.style);
  return { unionRect };
}

afterEach(() => vi.unstubAllGlobals());

test("content-visibility skips cached text and media rects without hiding visible content", () => {
  const hidden = new FixtureElement();
  hidden.painted = false;
  const media = new FixtureElement("IMG", hidden);
  media.painted = false;
  media.rect = rect(20, 20, 200, 200);
  const visible = new FixtureElement();
  page([text("hidden-until-found-id", hidden), text("Visible state", visible)], { media: [media] });
  const snapshot = collectLayout(1200);
  expect(snapshot.boxes.map((box) => box.text)).toEqual(["Visible state"]);
  expect(snapshot.images).toEqual([]);
  expect(hidden.checkVisibility).toHaveBeenCalledWith({ contentVisibilityAuto: true });
  expect(visible.checkVisibility).toHaveBeenCalledWith({ contentVisibilityAuto: true });
});

test("closed details keep only their own first summary even without checkVisibility", () => {
  const details = new FixtureElement("DETAILS");
  const summary = new FixtureElement("SUMMARY", details);
  const label = new FixtureElement("SPAN", summary);
  const body = new FixtureElement("DIV", details);
  const unrelatedSummary = new FixtureElement("SUMMARY", body);
  const secondSummary = new FixtureElement("SUMMARY", details);
  for (const element of [details, summary, label, body, unrelatedSummary, secondSummary]) element.checkVisibility = undefined;
  page([
    text("Technical details", label), text("event_fixture", body),
    text("Not the disclosure label", unrelatedSummary), text("Not the first summary", secondSummary),
  ]);
  expect(collectLayout(1200).boxes.map((box) => box.text)).toEqual(["Technical details"]);
  details.attributes.open = "";
  page([text("Technical details", label), text("event_fixture", body, [rect(20, 50, 100)])]);
  expect(collectLayout(1200).boxes.map((box) => box.text)).toEqual(["Technical details", "event_fixture"]);
});

test("an inner disclosure summary cannot escape a closed outer disclosure", () => {
  const outer = new FixtureElement("DETAILS");
  const outerSummary = new FixtureElement("SUMMARY", outer);
  const inner = new FixtureElement("DETAILS", outer);
  const innerSummary = new FixtureElement("SUMMARY", inner);
  const innerBody = new FixtureElement("DIV", inner);
  // Model the fallback as well as an API that returns true for the summary.
  innerSummary.checkVisibility = undefined;
  page([text("Technical details", outerSummary), text("Operation identifiers", innerSummary), text("request_fixture", innerBody)]);
  expect(collectLayout(1200).boxes.map((box) => box.text)).toEqual(["Technical details"]);
  outer.attributes.open = "";
  page([text("Technical details", outerSummary), text("Operation identifiers", innerSummary), text("request_fixture", innerBody)]);
  expect(collectLayout(1200).boxes.map((box) => box.text)).toEqual(["Technical details", "Operation identifiers"]);
});

test("display:contents text uses its rendered ancestor's visibility rather than a missing element box", () => {
  const parent = new FixtureElement();
  const contents = new FixtureElement("SPAN", parent);
  contents.style.display = "contents";
  contents.painted = false; // checkVisibility is false because this element has no box.
  page([text("Still drawn", contents)]);
  expect(collectLayout(1200).boxes.map((box) => box.text)).toEqual(["Still drawn"]);
  expect(contents.checkVisibility).not.toHaveBeenCalled();
  parent.painted = false;
  page([text("Not rendered by its ancestor", contents)]);
  expect(collectLayout(1200).boxes).toEqual([]);
});

test("wrapped inline text produces real line fragments, not a rectangle over its siblings", () => {
  const paragraph = new FixtureElement("P");
  const fixture = page([
    text("Read-only capacity policy.", paragraph, [rect(20, 20, 180)]),
    text("Billing is disabled.", paragraph, [rect(200, 20, 130)]),
    text("Usage stays available across two lines.", paragraph, [rect(330, 20, 90), rect(20, 44, 240)]),
  ]);
  const snapshot = collectLayout(1200);
  expect(snapshot.boxes.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
    { x: 20, y: 20, width: 180, height: 16 }, { x: 200, y: 20, width: 130, height: 16 },
    { x: 330, y: 20, width: 90, height: 16 }, { x: 20, y: 44, width: 240, height: 16 },
  ]);
  expect(checkOverlap(snapshot)).toEqual([]);
  expect(fixture.unionRect).not.toHaveBeenCalled();
});

test("each fragment retains clipping, inherited opacity, background, colour and control hooks", () => {
  const clip = new FixtureElement();
  clip.rect = rect(50, 20, 100, 80);
  clip.style.overflowX = clip.style.overflowY = "hidden";
  clip.style.opacity = "0.5";
  const button = new FixtureElement("BUTTON", clip);
  button.rect = rect(50, 20, 100, 80);
  button.style.opacity = "0.8";
  button.style.backgroundColor = "rgb(240, 242, 244)";
  button.attributes = { "data-testid": "clipped-control", "aria-disabled": "true" };
  const label = new FixtureElement("SPAN", button);
  label.attributes.class = "  fixture-label   wrapped  ";
  page([text("Wrapped control", label, [rect(40, 30, 80), rect(70, 60, 120), rect(70, 110, 100)])]);
  const snapshot = collectLayout(1200);
  expect(snapshot.boxes).toHaveLength(2);
  expect(snapshot.boxes.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
    { x: 50, y: 30, width: 70, height: 16 }, { x: 70, y: 60, width: 80, height: 16 },
  ]);
  for (const box of snapshot.boxes) expect(box).toMatchObject({
    opacity: 0.4, background: "rgb(240, 242, 244)", color: "rgba(17, 24, 39, 1)",
    interactive: true, controlWidth: 100, disabled: true, clipped: true,
    anchor: '[data-testid="clipped-control"]', classes: "fixture-label wrapped",
  });
});

test("hit testing and viewport exclusion apply to every fragment independently", () => {
  const element = new FixtureElement();
  const child = new FixtureElement("SPAN", element);
  const overlay = new FixtureElement();
  page([text("Three lines", element, [rect(20, 20, 100), rect(20, 44, 100), rect(20, 68, 100), rect(20, 700, 100), rect(20, 90, 0)])], {
    hit: (_x, y) => y < 40 ? child : y < 60 ? element.parentElement : overlay,
  });
  expect(collectLayout(1200).boxes.map((box) => box.y)).toEqual([20, 44]);
});

test("a multi-line node obeys the box limit and reports only additional painted fragments as truncated", () => {
  const element = new FixtureElement();
  page([text("Three visible lines", element, [rect(20, 20, 100), rect(20, 44, 100), rect(20, 68, 100)])]);
  const limited = collectLayout(2);
  expect(limited.boxes).toHaveLength(2);
  expect(limited.truncated).toBe(true);
  page([text("Two visible lines", element, [rect(20, 20, 100), rect(20, 44, 100), rect(20, 700, 100)])]);
  expect(collectLayout(2).truncated).toBe(false);
});

test("true visible overlap and faint text remain flagged while unpainted and transparent text is excluded", () => {
  const faint = new FixtureElement();
  faint.style.color = "rgb(205, 208, 214)";
  const transparent = new FixtureElement();
  transparent.style.opacity = "0.01";
  const hidden = new FixtureElement();
  hidden.style.visibility = "hidden";
  page([
    text("First overlapping line", new FixtureElement(), [rect(20, 20, 140)]),
    text("Second overlapping line", new FixtureElement(), [rect(30, 24, 150)]),
    text("Faint control", faint, [rect(20, 70, 120)]),
    text("Transparent control", transparent), text("Hidden control", hidden),
  ]);
  const snapshot = collectLayout(1200);
  expect(snapshot.boxes).toHaveLength(3);
  expect(checkOverlap(snapshot).map((note) => note.rule)).toEqual(["layout.overlap"]);
  expect(checkContrast(snapshot)[0]?.detail).toContain("Faint control");
});
