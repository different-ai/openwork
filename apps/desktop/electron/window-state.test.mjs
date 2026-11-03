import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WINDOW_STATE_FILENAME, createWindowStateStore, fitBoundsToDisplays, parseWindowState } from "./window-state.mjs";

const laptop = { x: 0, y: 25, width: 1440, height: 875 };
const monitor = { x: 1440, y: 0, width: 2560, height: 1440 };

describe("window state", () => {
  it("parses only the current version with usable bounds", () => {
    assert.deepEqual(
      parseWindowState({ version: 1, bounds: { x: 10.4, y: 20, width: 900, height: 700 }, maximized: true }),
      { bounds: { x: 10, y: 20, width: 900, height: 700 }, maximized: true },
    );
    assert.equal(parseWindowState({ version: 2, bounds: { x: 0, y: 0, width: 900, height: 700 } }), null);
    assert.equal(parseWindowState({ version: 1, bounds: { x: 0, y: 0, width: 0, height: 700 } }), null);
    assert.equal(parseWindowState({ version: 1, bounds: { x: "0", y: 0, width: 900, height: 700 } }), null);
    assert.equal(parseWindowState(null), null);
  });

  it("keeps bounds that fit on a connected display", () => {
    const bounds = { x: 1600, y: 100, width: 1200, height: 900 };
    assert.deepEqual(fitBoundsToDisplays(bounds, [laptop, monitor]), bounds);
  });

  it("falls back when the display the window was on is gone", () => {
    assert.equal(fitBoundsToDisplays({ x: 1600, y: 100, width: 1200, height: 900 }, [laptop]), null);
  });

  it("moves a window whose title bar is barely visible back onto the display", () => {
    const fitted = fitBoundsToDisplays({ x: 1300, y: 600, width: 1000, height: 700 }, [laptop]);
    assert.deepEqual(fitted, { x: 440, y: 200, width: 1000, height: 700 });
  });

  it("shrinks a window larger than the display it lands on", () => {
    const fitted = fitBoundsToDisplays({ x: 0, y: 25, width: 2400, height: 1400 }, [laptop]);
    assert.deepEqual(fitted, laptop);
  });

  it("restores saved bounds and saves normal bounds when the window closes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openwork-window-state-"));
    try {
      const screen = { getAllDisplays: () => [{ workArea: laptop }] };
      const store = createWindowStateStore({ directory, screen });
      assert.deepEqual(store.initialOptions({ width: 1180, height: 820 }), { options: { width: 1180, height: 820 }, maximized: false });

      await writeFile(
        path.join(directory, WINDOW_STATE_FILENAME),
        JSON.stringify({ version: 1, bounds: { x: 100, y: 80, width: 1000, height: 700 }, maximized: true }),
      );
      assert.deepEqual(store.initialOptions({ width: 1180, height: 820 }), {
        options: { x: 100, y: 80, width: 1000, height: 700 },
        maximized: true,
      });

      const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        isMinimized: () => false,
        isFullScreen: () => false,
        isMaximized: () => false,
        getNormalBounds: () => ({ x: 200, y: 120, width: 1100, height: 760 }),
      });
      // @ts-expect-error a minimal stand-in for BrowserWindow
      store.track(window);
      window.emit("close");
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, WINDOW_STATE_FILENAME), "utf8")), {
        version: 1,
        bounds: { x: 200, y: 120, width: 1100, height: 760 },
        maximized: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
