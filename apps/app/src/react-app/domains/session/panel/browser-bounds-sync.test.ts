import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { computeBrowserBounds, createBrowserBoundsSync, type BrowserBounds } from "./browser-bounds-sync";

GlobalRegistrator.register({ width: 1200, height: 1000 });

const BOUNDS = { x: 800, y: 40, width: 400, height: 900 };

// Happy DOM has styles and ancestry but no layout engine. Supply rectangles and
// client boxes explicitly; these tests do not claim real Electron rendering.
type ClientBox = Pick<HTMLElement, "offsetWidth" | "offsetHeight" | "clientLeft" | "clientTop" | "clientWidth" | "clientHeight">;

function layout(el: HTMLElement, bounds: BrowserBounds, border = 0, metrics: Partial<ClientBox> = {}) {
  el.getBoundingClientRect = () => new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height);
  const box: ClientBox = {
    offsetWidth: bounds.width,
    offsetHeight: bounds.height,
    clientLeft: border,
    clientTop: border,
    clientWidth: bounds.width - 2 * border,
    clientHeight: bounds.height - 2 * border,
    ...metrics,
  };
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(el, key, { configurable: true, value });
  }
}

function containerFixture() {
  const shell = document.createElement("div");
  const content = document.createElement("div");
  shell.style.overflowX = "hidden";
  shell.style.overflowY = "hidden";
  shell.append(content);
  document.body.append(shell);
  layout(shell, BOUNDS);
  layout(content, BOUNDS);
  return { shell, content };
}

test("native placement intersects clipping ancestors, borders, and the viewport instead of spilling into chat", () => {
  const { shell, content } = containerFixture();
  try {
    assert.deepEqual(computeBrowserBounds(content), BOUNDS);
    layout(content, { x: 600, y: -20, width: 900, height: 1200 });
    assert.deepEqual(computeBrowserBounds(content), BOUNDS, "oversized child stays in its pane");
    layout(shell, BOUNDS, 2);
    assert.deepEqual(computeBrowserBounds(content), { x: 802, y: 42, width: 396, height: 896 });
    shell.style.overflowX = "visible";
    shell.style.overflowY = "visible";
    assert.deepEqual(computeBrowserBounds(content), { x: 600, y: 0, width: 600, height: 1000 });
    shell.style.contain = "paint";
    assert.deepEqual(computeBrowserBounds(content), { x: 802, y: 42, width: 396, height: 896 });
  } finally {
    shell.remove();
  }
});

test("a clipped, hidden, or detached container cannot keep the native browser above the app", async () => {
  const { shell, content } = containerFixture();
  const f = fixture();
  try {
    for (const css of ["visibility: hidden", "display: none", "opacity: 0", "content-visibility: hidden"]) {
      f.sync.sync(computeBrowserBounds(content), 2, false);
      await setImmediate();
      const before = f.hides;
      shell.style.cssText = css;
      assert.equal(computeBrowserBounds(content), null, css);
      f.sync.sync(computeBrowserBounds(content), 2, false);
      assert.equal(f.hides, before + 1);
      shell.style.cssText = "overflow-x: hidden; overflow-y: hidden";
    }
    layout(content, { ...BOUNDS, x: 1400 });
    assert.equal(computeBrowserBounds(content), null, "fully clipped child is hidden");
    layout(content, BOUNDS);
    shell.remove();
    assert.equal(computeBrowserBounds(content), null, "detached owner has no native placement");
  } finally {
    f.sync.dispose();
    shell.remove();
  }
});

test("independent nested overflow clips intersect per axis in either ancestor order", () => {
  const { shell, content } = containerFixture();
  const inner = document.createElement("div");
  shell.append(inner);
  inner.append(content);
  try {
    layout(content, { x: -100, y: -100, width: 1500, height: 1300 });
    for (const [horizontal, vertical] of [[shell, inner], [inner, shell]]) {
      horizontal.style.cssText = "overflow-x: clip; overflow-y: visible";
      vertical.style.cssText = "overflow-x: visible; overflow-y: clip";
      layout(horizontal, { x: 820, y: -40, width: 280, height: 20 });
      layout(vertical, { x: -40, y: 70, width: 20, height: 500 });
      assert.deepEqual(computeBrowserBounds(content), { x: 820, y: 70, width: 280, height: 500 });
      layout(vertical, { x: -40, y: 1000, width: 20, height: 100 });
      assert.equal(computeBrowserBounds(content), null, "an empty intersection on either axis hides");
    }
  } finally {
    shell.remove();
  }
});

test("asymmetric borders and scrollbars, including a left scrollbar, stay outside native bounds", () => {
  const { shell, content } = containerFixture();
  try {
    shell.style.cssText = "overflow-x: scroll; overflow-y: auto; direction: rtl";
    layout(shell, BOUNDS, 0, { clientLeft: 19, clientTop: 3, clientWidth: 374, clientHeight: 876 });
    assert.deepEqual(computeBrowserBounds(content), { x: 819, y: 43, width: 374, height: 876 });
  } finally {
    shell.remove();
  }
});

test("fractional translated and independently scaled client boxes stay in CSS pixels through sync", async () => {
  const { shell, content } = containerFixture();
  const f = fixture();
  try {
    shell.style.transform = "translate(0.25px, 0.5px) scale(1.25, 0.75)";
    layout(shell, { x: 800.25, y: 40.5, width: 400, height: 900 }, 0, {
      offsetWidth: 320, offsetHeight: 1200, clientLeft: 3, clientTop: 5, clientWidth: 303, clientHeight: 1183,
    });
    layout(content, { x: 700.5, y: 30.25, width: 500, height: 1000.25 });
    const expected = { x: 804, y: 44.25, width: 378.75, height: 887.25 };
    assert.deepEqual(computeBrowserBounds(content), expected);
    f.sync.sync(computeBrowserBounds(content), 2, false);
    await setImmediate();
    f.sync.sync(computeBrowserBounds(content), 2.5, false);
    await setImmediate();
    f.sync.sync(computeBrowserBounds(content), 2.5, false);
    assert.deepEqual(f.shows, [{ bounds: expected, sessionId: "A" }]);
    assert.deepEqual(f.updates, [expected], "DPR changes only invalidate dedup, not scale or round");
  } finally {
    f.sync.dispose();
    shell.remove();
  }
});

test("transforms and non-paint containment do not independently clip overflowing descendants", () => {
  const { shell, content } = containerFixture();
  try {
    layout(content, { x: 700.25, y: -10.5, width: 600, height: 1100 });
    shell.style.cssText = "overflow-x: visible; overflow-y: visible; transform: translateX(30px) scale(0.5)";
    for (const contain of ["none", "layout", "style", "size", "inline-size", "layout style"]) {
      shell.style.contain = contain;
      assert.deepEqual(computeBrowserBounds(content), { x: 700.25, y: 0, width: 499.75, height: 1000 }, contain);
    }
    for (const contain of ["paint", "strict", "content", "layout paint style"]) {
      shell.style.contain = contain;
      assert.deepEqual(computeBrowserBounds(content), BOUNDS, contain);
    }
  } finally {
    shell.remove();
  }
});

test("display:contents ancestors have no clipping or opacity box but do not bypass outer clips", () => {
  const { shell, content } = containerFixture();
  const wrapper = document.createElement("div");
  shell.append(wrapper);
  wrapper.append(content);
  try {
    layout(wrapper, { x: 0, y: 0, width: 0, height: 0 });
    layout(content, { x: 600, y: 10, width: 900, height: 1200 });
    for (const css of [
      "overflow-x: hidden; overflow-y: hidden",
      "contain: paint",
      "opacity: 0",
      "content-visibility: hidden",
    ]) {
      wrapper.style.cssText = `display: contents; ${css}`;
      assert.deepEqual(computeBrowserBounds(content), BOUNDS, css);
    }
    wrapper.style.cssText = "display: contents; visibility: hidden";
    assert.equal(computeBrowserBounds(content), null, "boxless ancestry still participates in visibility");
    wrapper.style.cssText = "display: contents";
    content.style.display = "contents";
    layout(content, { x: 0, y: 0, width: 0, height: 0 });
    assert.equal(computeBrowserBounds(content), null, "a boxless owner cannot place a native view");
  } finally {
    shell.remove();
  }
});

test("content-visibility:auto supplies paint containment even with visible overflow and no explicit contain", () => {
  const { shell, content } = containerFixture();
  try {
    shell.style.cssText = "content-visibility: auto; overflow-x: visible; overflow-y: visible";
    layout(shell, BOUNDS, 2);
    layout(content, { x: 500, y: 10, width: 1000, height: 1200 });
    assert.deepEqual(computeBrowserBounds(content), { x: 802, y: 42, width: 396, height: 896 });
    shell.style.contentVisibility = "hidden";
    assert.equal(computeBrowserBounds(content), null);
    shell.style.contentVisibility = "visible";
    assert.deepEqual(computeBrowserBounds(content), { x: 500, y: 10, width: 700, height: 990 });
  } finally {
    shell.remove();
  }
});

test("zero-sized ancestors only suppress descendants on axes they actually clip", () => {
  const { shell, content } = containerFixture();
  try {
    layout(shell, { x: 900, y: 100, width: 0, height: 0 });
    shell.style.cssText = "overflow-x: visible; overflow-y: visible";
    assert.deepEqual(computeBrowserBounds(content), BOUNDS);
    for (const css of ["overflow-x: clip", "overflow-y: clip", "contain: paint"]) {
      shell.style.cssText = css;
      assert.equal(computeBrowserBounds(content), null, css);
    }
    layout(shell, { ...BOUNDS, width: 0.25 }, 0, { offsetWidth: 0, clientWidth: 0 });
    shell.style.cssText = "overflow-x: clip; overflow-y: visible";
    assert.equal(computeBrowserBounds(content), null, "rounded zero client extent cannot become a viewport-sized clip");
    layout(shell, BOUNDS);
    assert.deepEqual(computeBrowserBounds(content), BOUNDS);
  } finally {
    shell.remove();
  }
});

test("reparenting through a detached or hidden ancestor invalidates placement and recovers at identical geometry", async () => {
  const { shell, content } = containerFixture();
  const detached = document.createElement("div");
  const f = fixture();
  try {
    f.sync.sync(computeBrowserBounds(content), 1, false);
    await setImmediate();
    detached.append(shell);
    assert.equal(computeBrowserBounds(content), null);
    f.sync.sync(computeBrowserBounds(content), 1, false);
    document.body.append(detached);
    detached.style.display = "none";
    assert.equal(computeBrowserBounds(content), null, "stale child geometry cannot override a hidden ancestor");
    f.sync.sync(computeBrowserBounds(content), 1, false);
    detached.style.display = "block";
    detached.style.visibility = "collapse";
    assert.equal(computeBrowserBounds(content), null);
    f.sync.sync(computeBrowserBounds(content), 1, false);
    detached.style.visibility = "visible";
    assert.deepEqual(computeBrowserBounds(content), BOUNDS);
    f.sync.sync(computeBrowserBounds(content), 1, false);
    await setImmediate();
    assert.equal(f.hides, 1);
    assert.deepEqual(f.shows, [{ bounds: BOUNDS, sessionId: "A" }, { bounds: BOUNDS, sessionId: "A" }]);
    assert.deepEqual(f.updates, []);
  } finally {
    f.sync.dispose();
    detached.remove();
    shell.remove();
  }
});

test("nonfinite or negative owner measurements cannot be laundered into valid viewport bounds", () => {
  const { shell, content } = containerFixture();
  try {
    for (const key of ["x", "y", "width", "height"]) {
      const values = [NaN, Infinity, -Infinity, ...(["width", "height"].includes(key) ? [-1] : [])];
      for (const value of values) {
        layout(content, { ...BOUNDS, [key]: value });
        assert.equal(computeBrowserBounds(content), null, `${key}=${value}`);
        layout(content, BOUNDS);
        assert.deepEqual(computeBrowserBounds(content), BOUNDS, "valid layout recovers without remounting");
      }
    }
  } finally {
    shell.remove();
  }
});

test("malformed ancestor client measurements fail closed and recover without retaining the bad clip", () => {
  const { shell, content } = containerFixture();
  try {
    for (const key of ["offsetWidth", "offsetHeight", "clientLeft", "clientTop", "clientWidth", "clientHeight"]) {
      for (const value of [NaN, Infinity, -Infinity, -1]) {
        layout(shell, BOUNDS, 2, { [key]: value });
        assert.equal(computeBrowserBounds(content), null, `${key}=${value}`);
        layout(shell, BOUNDS, 2);
        assert.deepEqual(computeBrowserBounds(content), { x: 802, y: 42, width: 396, height: 896 });
      }
    }
  } finally {
    shell.remove();
  }
});

test("invalid clipping-ancestor rectangles cannot turn into a permissive clip", () => {
  const { shell, content } = containerFixture();
  try {
    for (const key of ["x", "y", "width", "height"]) {
      for (const value of [NaN, Infinity, -Infinity, ...(["width", "height"].includes(key) ? [-1] : [])]) {
        layout(shell, { ...BOUNDS, [key]: value }, 2, { offsetWidth: 400, offsetHeight: 900, clientWidth: 396, clientHeight: 896 });
        assert.equal(computeBrowserBounds(content), null, `${key}=${value}`);
        layout(shell, BOUNDS);
        assert.deepEqual(computeBrowserBounds(content), BOUNDS);
      }
    }
  } finally {
    shell.remove();
  }
});

test("an owner connected to a document without a window cannot place the native browser", () => {
  const isolatedDocument = document.implementation.createHTMLDocument();
  const content = isolatedDocument.createElement("div");
  isolatedDocument.body.append(content);
  layout(content, BOUNDS);
  assert.equal(content.isConnected, true);
  assert.equal(computeBrowserBounds(content), null);
});

test("invalid viewport extents do not produce a native placement and a restored viewport recovers", () => {
  const { shell, content } = containerFixture();
  const original = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  try {
    for (const key of ["innerWidth", "innerHeight"]) {
      for (const value of [NaN, Infinity, -Infinity, -1, 0]) {
        Object.defineProperty(window, key, { configurable: true, value });
        assert.equal(computeBrowserBounds(content), null, `${key}=${value}`);
        Object.defineProperties(window, {
          innerWidth: { configurable: true, value: original.innerWidth },
          innerHeight: { configurable: true, value: original.innerHeight },
        });
        assert.deepEqual(computeBrowserBounds(content), BOUNDS);
      }
    }
  } finally {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: original.innerWidth },
      innerHeight: { configurable: true, value: original.innerHeight },
    });
    shell.remove();
  }
});

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const shows: { bounds: BrowserBounds; sessionId: string }[] = [];
  const updates: BrowserBounds[] = [];
  const errors: unknown[] = [];
  const controls = { show: async () => true, setBounds: async () => true };
  let hides = 0;
  const sync = createBrowserBoundsSync({
    show(bounds, sessionId) {
      shows.push({ bounds, sessionId });
      return controls.show();
    },
    setBounds(bounds) {
      updates.push(bounds);
      return controls.setBounds();
    },
    async hide() { hides++; },
  }, "A", (error) => { errors.push(error); });
  return { sync, shows, updates, errors, controls, get hides() { return hides; } };
}

test("invalid and subpixel sync rectangles hide once per invalid streak and recover at the original geometry", async () => {
  const f = fixture();
  try {
    for (const invalid of [
      null,
      { ...BOUNDS, x: NaN },
      { ...BOUNDS, y: Infinity },
      { ...BOUNDS, x: -Infinity },
      { ...BOUNDS, width: Infinity },
      { ...BOUNDS, height: NaN },
      { ...BOUNDS, width: -1 },
      { ...BOUNDS, height: -1 },
      { ...BOUNDS, width: 0 },
      { ...BOUNDS, height: 0.5 },
    ]) {
      f.sync.sync(BOUNDS, 1.5, false);
      await setImmediate();
      const before = f.hides;
      f.sync.sync(invalid, 1.5, false);
      f.sync.sync(invalid, 1.5, false);
      assert.equal(f.hides, before + 1);
      const shown = f.shows.length;
      f.sync.sync(BOUNDS, 1.5, false);
      await setImmediate();
      assert.equal(f.shows.length, shown + 1);
      f.sync.sync(BOUNDS, 1.5, false);
      assert.equal(f.shows.length, shown + 1);
    }
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.errors, []);
  } finally {
    f.sync.dispose();
  }
});

const acknowledgements = [
  { name: "accepted", settle: (pending: ReturnType<typeof deferred>) => pending.resolve(true) },
  { name: "refused", settle: (pending: ReturnType<typeof deferred>) => pending.resolve(false) },
  { name: "rejected", settle: (pending: ReturnType<typeof deferred>) => pending.reject(new Error("Superseded")) },
];

for (const acknowledgement of acknowledgements) {
  test(`partial clipping hides a pending show immediately and recovers after its ${acknowledgement.name} acknowledgement`, async () => {
    const { shell, content } = containerFixture();
    const f = fixture();
    const pending = deferred();
    try {
      f.controls.show = () => pending.promise;
      f.sync.sync(computeBrowserBounds(content), 1, false);
      f.sync.invalidate();
      layout(shell, { x: 900, y: 100, width: 300, height: 600 });
      f.sync.sync(computeBrowserBounds(content), 1, false);
      assert.equal(f.hides, 1, "the initial larger native rectangle must not remain above the clipped pane while show is pending");
      layout(shell, { ...BOUNDS, x: 1300 });
      f.sync.sync(computeBrowserBounds(content), 1, false);
      layout(shell, BOUNDS);
      shell.style.visibility = "hidden";
      f.sync.sync(computeBrowserBounds(content), 1, false);
      shell.style.visibility = "visible";
      const latest = { x: 950, y: 200, width: 250, height: 400 };
      layout(shell, latest);
      for (let frame = 0; frame < 5; frame++) f.sync.sync(computeBrowserBounds(content), 2, false);
      assert.equal(f.hides, 1);
      assert.equal(f.shows.length, 1, "no concurrent shows during rapid hide/reveal");
      assert.deepEqual(f.updates, []);
      acknowledgement.settle(pending);
      await setImmediate();
      assert.equal(f.shows.length, 1, "acknowledgements do not replay stale geometry");
      f.controls.show = async () => true;
      f.sync.sync(computeBrowserBounds(content), 2, false);
      await setImmediate();
      f.sync.sync(computeBrowserBounds(content), 2, false);
      assert.deepEqual(f.shows, [{ bounds: BOUNDS, sessionId: "A" }, { bounds: latest, sessionId: "A" }]);
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.errors, []);
    } finally {
      pending.resolve(true);
      f.sync.dispose();
      shell.remove();
      await setImmediate();
    }
  });

  test(`a ${acknowledgement.name} stale bounds acknowledgement cannot poison a newer show or bounds after clipping and reveal`, async () => {
    for (const settleBeforeShow of [true, false]) {
      const { shell, content } = containerFixture();
      const f = fixture();
      const oldBounds = deferred();
      const nextShow = deferred();
      try {
        f.sync.sync(computeBrowserBounds(content), 1, false);
        await setImmediate();
        const clipped = { x: 900, y: 100, width: 300, height: 600 };
        layout(shell, clipped);
        f.controls.setBounds = () => oldBounds.promise;
        f.sync.sync(computeBrowserBounds(content), 1, false);
        assert.deepEqual(f.updates, [clipped]);
        layout(shell, { ...BOUNDS, width: 0 });
        f.sync.sync(computeBrowserBounds(content), 1, false);
        f.sync.sync(computeBrowserBounds(content), 1, false);
        const revealed = { x: 850, y: 60, width: 350, height: 800 };
        layout(shell, revealed);
        f.controls.show = () => nextShow.promise;
        f.sync.sync(computeBrowserBounds(content), 1, false);
        if (settleBeforeShow) {
          acknowledgement.settle(oldBounds);
          await setImmediate();
        }
        nextShow.resolve(true);
        await setImmediate();
        const latest = { x: 950, y: 200, width: 250, height: 400 };
        layout(shell, latest);
        f.controls.setBounds = async () => true;
        f.sync.sync(computeBrowserBounds(content), 2, false);
        await setImmediate();
        if (!settleBeforeShow) {
          acknowledgement.settle(oldBounds);
          await setImmediate();
        }
        f.sync.sync(computeBrowserBounds(content), 2, false);
        assert.equal(f.hides, 1);
        assert.deepEqual(f.shows, [{ bounds: BOUNDS, sessionId: "A" }, { bounds: revealed, sessionId: "A" }]);
        assert.deepEqual(f.updates, [clipped, latest]);
        assert.deepEqual(f.errors, []);
      } finally {
        oldBounds.resolve(true);
        nextShow.resolve(true);
        f.sync.dispose();
        shell.remove();
        await setImmediate();
      }
    }
  });

  test(`disposal ignores ${acknowledgement.name} late show and bounds acknowledgements without reviving the page`, async () => {
    for (const operation of ["show", "setBounds"]) {
      const f = fixture();
      const pending = deferred();
      try {
        if (operation === "setBounds") {
          f.sync.sync(BOUNDS, 1, false);
          await setImmediate();
          f.controls.setBounds = () => pending.promise;
        } else {
          f.controls.show = () => pending.promise;
        }
        f.sync.sync({ ...BOUNDS, width: 300 }, 1, false);
        f.sync.dispose();
        const before = { shows: f.shows.length, updates: f.updates.length, hides: f.hides };
        acknowledgement.settle(pending);
        await setImmediate();
        f.sync.invalidate();
        f.sync.sync(BOUNDS, 2, false);
        f.sync.sync(null, 2, false);
        assert.deepEqual({ shows: f.shows.length, updates: f.updates.length, hides: f.hides }, before);
        assert.equal(f.hides, 1);
        assert.deepEqual(f.errors, []);
      } finally {
        pending.resolve(true);
        await setImmediate();
      }
    }
  });
}

test("shared RAF/RO writer deduplicates idle frames but sends post-RAF layout changes immediately", async () => {
  const { sync, shows, updates } = fixture();
  sync.sync(BOUNDS, 2, false);
  await setImmediate();
  for (let frame = 0; frame < 100; frame++) sync.sync({ ...BOUNDS }, 2, false);
  assert.deepEqual(shows, [{ bounds: BOUNDS, sessionId: "A" }]);
  assert.deepEqual(updates, []);

  // RO can settle panel constraints after RAF. It uses this same writer,
  // which must send now, not defer the new rectangle to another frame.
  const resized = { ...BOUNDS, x: 700, width: 500 };
  sync.sync(resized, 2, false);
  assert.deepEqual(updates, [resized]);
  sync.sync({ ...resized }, 2, false);
  assert.equal(updates.length, 1);
  await setImmediate();

  sync.sync(resized, 2.5, false);
  assert.deepEqual(updates, [resized, resized]);
  await setImmediate();
  sync.invalidate();
  sync.sync(resized, 2.5, false);
  assert.deepEqual(updates, [resized, resized, resized]); // DPR never scales CSS bounds.
});

test("a rejected show stays a failed intent until geometry changes or explicit invalidation", async () => {
  const { sync, shows, updates, controls, errors } = fixture();
  const pending = deferred();
  controls.show = () => pending.promise;
  sync.sync(BOUNDS, 1, false);
  for (let frame = 0; frame < 10; frame++) sync.sync(BOUNDS, 1, false);
  assert.equal(shows.length, 1);
  assert.deepEqual(updates, []);
  pending.resolve(false);
  await setImmediate();
  for (let frame = 0; frame < 10; frame++) {
    sync.sync(BOUNDS, 1, false);
    await setImmediate();
  }
  assert.equal(shows.length, 1);
  assert.deepEqual(errors, []);
  controls.show = async () => true;
  sync.invalidate();
  sync.sync(BOUNDS, 1, false);
  assert.equal(shows.length, 2);
  await setImmediate();
  sync.sync(BOUNDS, 1, false);
  assert.deepEqual(updates, []);
});

test("permanent show errors report once per intent instead of retrying and toasting every frame", async () => {
  const { sync, shows, updates, controls, errors } = fixture();
  const error = new Error("Browser unavailable");
  controls.show = async () => { throw error; };
  for (let frame = 0; frame < 10; frame++) {
    sync.sync(BOUNDS, 1, false);
    await setImmediate();
  }
  assert.equal(shows.length, 1);
  assert.deepEqual(errors, [error]);
  assert.deepEqual(updates, []);

  const resized = { ...BOUNDS, width: 450 };
  controls.show = async () => true;
  sync.sync(resized, 1, false);
  assert.equal(shows.length, 2);
  await setImmediate();
  sync.sync(resized, 1, false);
  assert.deepEqual(updates, []);
});

test("hide supersedes pending show without concurrent shows, stale toasts, or a poisoned cache", async () => {
  const f = fixture();
  const pending = deferred();
  f.controls.show = () => pending.promise;
  f.sync.sync(BOUNDS, 1, false);
  f.sync.invalidate();
  f.sync.sync(BOUNDS, 1, true);
  f.sync.sync(BOUNDS, 1, true);
  assert.equal(f.hides, 1);
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 1, "the old show remains the only in-flight show");
  pending.reject(new Error("Superseded"));
  await setImmediate();
  assert.deepEqual(f.errors, []);
  f.controls.show = async () => true;
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 2);
  await setImmediate();
  f.sync.sync(BOUNDS, 1, true);
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 3, "hide clears same-geometry dedup");
});

test("invalidation during a pending show is not lost, and disposal ignores late show failure", async () => {
  const f = fixture();
  const pending = deferred();
  f.controls.show = () => pending.promise;
  f.sync.sync(BOUNDS, 1, false);
  f.sync.invalidate();
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 1);
  pending.resolve(false);
  await setImmediate();
  const next = deferred();
  f.controls.show = () => next.promise;
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 2);
  f.sync.dispose();
  next.reject(new Error("Disposed"));
  await setImmediate();
  f.sync.invalidate();
  f.sync.sync(BOUNDS, 2, false);
  assert.equal(f.shows.length, 2);
  assert.equal(f.hides, 1);
  assert.deepEqual(f.errors, []);
});

test("failed bounds sends clear local dedup but superseded failures cannot clear newer geometry", async () => {
  const { sync, updates, controls } = fixture();
  sync.sync(BOUNDS, 1, false);
  await setImmediate();
  const first = { ...BOUNDS, width: 450 };
  const latest = { ...BOUNDS, width: 500 };
  const pending = deferred();
  controls.setBounds = () => pending.promise;
  sync.sync(first, 1, false);
  controls.setBounds = async () => true;
  sync.sync(latest, 1, false);
  await setImmediate();
  pending.reject(new Error("Old bounds failed"));
  await setImmediate();
  sync.sync(latest, 1, false);
  assert.deepEqual(updates, [first, latest]);

  for (const fail of [async () => false, async () => { throw new Error("Bounds failed"); }]) {
    controls.setBounds = fail;
    sync.invalidate();
    sync.sync(latest, 1, false);
    await setImmediate();
    const count = updates.length;
    controls.setBounds = async () => true;
    sync.sync(latest, 1, false);
    assert.equal(updates.length, count + 1);
    await setImmediate();
  }
});
