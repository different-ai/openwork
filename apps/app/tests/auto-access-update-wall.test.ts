import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost" });
afterAll(() => GlobalRegistrator.unregister());
import { autoAccessWallFromError, autoPickerCopy, autoUpdateTarget, autoWallCopy } from "../src/app/lib/inference-access";
import { openAutoUpdate } from "../src/react-app/domains/cloud/auto-access-ui";
import { useUpdateCheckRequestStore } from "../src/react-app/domains/settings/state/update-check-request";

describe("Auto update wall", () => {
  beforeEach(() => {
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    window.location.hash = "";
  });

  test("names the oldest supported release when the gateway reports one", () => {
    expect(autoUpdateTarget("0.18.51")).toBe("OpenWork v0.18.51 or newer");
    expect(autoUpdateTarget("v0.18.51")).toBe("OpenWork v0.18.51 or newer");
    expect(autoUpdateTarget(null)).toBe("OpenWork");
    expect(autoWallCopy({ state: "update", minimumVersion: "0.18.51" }, false).detail).toContain("Update to OpenWork v0.18.51 or newer");
    expect(autoWallCopy({ state: "update" }, false).detail).toContain("Update to OpenWork or switch");
    expect(autoPickerCopy("update_required", false, "0.18.51").detail).toBe("Update to OpenWork v0.18.51 or newer to keep using Auto. Your draft is kept.");
    expect(autoPickerCopy("update_required", true).action).toBe("Update");
  });

  test("a gateway update rejection keeps its minimum version through to the wall", () => {
    expect(autoAccessWallFromError({ error: { code: "desktop_update_required", minimumVersion: "0.18.51" } })).toEqual({ state: "update", minimumVersion: "0.18.51" });
    expect(autoAccessWallFromError({ code: "desktop_update_required", minimumVersion: "" })).toEqual({ state: "update" });
    expect(autoAccessWallFromError({ code: "desktop_update_required" })).toEqual({ state: "update" });
  });

  test("Update OpenWork starts the update check and opens the Updates tab in the current workspace", () => {
    window.location.hash = "#/workspace/ws_1/session/ses_1";
    openAutoUpdate();
    expect(window.location.hash).toBe("#/workspace/ws_1/settings/updates");
    expect(useUpdateCheckRequestStore.getState().requestedAt).not.toBeNull();
    window.location.hash = "#/settings/ai";
    openAutoUpdate();
    expect(window.location.hash).toBe("#/settings/updates");
  });
});
