import assert from "node:assert/strict";
import test from "node:test";

import { resetMacDockIcon } from "./brand-icon-darwin.mjs";

function fakeDock() {
  const calls = [];
  return {
    calls,
    setIcon(image) {
      calls.push(image);
    },
  };
}

test("re-applies the loose default icon when one exists (dev builds)", () => {
  const dock = fakeDock();
  const image = { isEmpty: () => false };

  assert.deepEqual(resetMacDockIcon(dock, image), { ok: true });
  assert.deepEqual(dock.calls, [image]);
});

test("restores the bundle icon via setIcon(null) when no loose default icon ships (packaged builds)", () => {
  const dock = fakeDock();

  assert.deepEqual(resetMacDockIcon(dock, null), { ok: true });
  assert.deepEqual(dock.calls, [null]);
});

test("treats an empty default image like a missing one", () => {
  const dock = fakeDock();

  assert.deepEqual(resetMacDockIcon(dock, { isEmpty: () => true }), { ok: true });
  assert.deepEqual(dock.calls, [null]);
});

test("reports when the dock is unavailable instead of throwing", () => {
  assert.deepEqual(resetMacDockIcon(null, null), { ok: false, reason: "dock-unavailable" });
  assert.deepEqual(resetMacDockIcon(undefined, { isEmpty: () => false }), {
    ok: false,
    reason: "dock-unavailable",
  });
});
