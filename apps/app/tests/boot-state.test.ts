import { describe, expect, test } from "bun:test";

import { bootOverlayCanHide } from "../src/react-app/shell/boot-state";

describe("boot overlay visibility", () => {
  test("waits for both boot and route readiness", () => {
    expect(bootOverlayCanHide("ready", false)).toBe(false);
    expect(bootOverlayCanHide("starting-engine", true)).toBe(false);
    expect(bootOverlayCanHide("ready", true)).toBe(true);
    expect(bootOverlayCanHide("idle", true)).toBe(true);
  });
});
