import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { beginWebSigninRedirect, finishWebSigninRedirect, safeWebSigninReturn, webSigninTarget } from "../src/react-app/domains/cloud/web-signin-redirect";
import { tryOpenBrowserAuthUrl } from "../src/react-app/domains/cloud/open-browser-auth";

GlobalRegistrator.register({ url: "https://web.example.test/signin" });
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  window.sessionStorage.clear();
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
});
const origin = "https://web.example.test";
const auth = "https://den.example.test/?mode=sign-in&webAuth=1&webAuthReturn=https%3A%2F%2Fweb.example.test";

describe("gateway same-tab sign-in", () => {
  test("only an HTTP(S) web handoff to another configured origin can navigate", () => {
    expect(webSigninTarget(auth, origin)).toBe(auth);
    for (const target of ["javascript:alert(1)", "not a url", "https://den.example.test/?desktopAuth=1", auth.replace("web.example.test", "outside.example.test"), auth.replace("https://den.example.test", origin), auth.replace("den.example.test", "user:pass@den.example.test"), `${auth}&desktopAuth=1`]) {
      expect(webSigninTarget(target, origin)).toBeNull();
    }
  });

  test("keeps an internal deep link and strips callback credentials", () => {
    expect(safeWebSigninReturn("/workspace/w/session/s?tab=files&grant=secret&token=secret#notes", origin)).toBe("/workspace/w/session/s?tab=files#notes");
    for (const path of ["https://outside.example.test", "//outside.example.test", "/\\outside.example.test", "/signin", "/signin/again", "/onboarding", "/welcome"]) {
      expect(safeWebSigninReturn(path, origin)).toBeNull();
    }
  });

  test("attempts automatically only once per tab and restores the deep link once", () => {
    const storage = window.sessionStorage;
    expect(beginWebSigninRedirect(storage, auth, "/workspace/w/session/s?tab=files#notes", origin)).toBe(true);
    expect(beginWebSigninRedirect(storage, auth, "/signin", origin)).toBe(false);
    expect(finishWebSigninRedirect(storage, origin)).toBe("/workspace/w/session/s?tab=files#notes");
    expect(finishWebSigninRedirect(storage, origin)).toBeNull();
    expect(beginWebSigninRedirect(storage, auth, "/session", origin)).toBe(true);
  });

  test("does not auto-redirect without durable loop protection", () => {
    const blocked = new Proxy(window.sessionStorage, {
      get(target, key) {
        if (key === "getItem") return () => { throw new Error("Storage disabled"); };
        return Reflect.get(target, key);
      },
    });
    expect(beginWebSigninRedirect(blocked, auth, "/session", origin)).toBe(false);
  });

  test("rejects an externally modified stored return path", () => {
    window.sessionStorage.setItem("openwork.webSignin.return", "//outside.example.test");
    expect(finishWebSigninRedirect(window.sessionStorage, origin)).toBeNull();
  });

  test("manual gateway retry navigates the same tab without a popup", async () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    const open = spyOn(window, "open").mockReturnValue(null);
    expect(await tryOpenBrowserAuthUrl(auth, true)).toBe(true);
    expect(assign).toHaveBeenCalledWith(auth);
    expect(open).not.toHaveBeenCalled();
    assign.mockRestore();
    open.mockRestore();
  });

  test("Electron always uses its external browser bridge, even with same-tab requested", async () => {
    const opened: string[] = [];
    Reflect.set(window, "__OPENWORK_ELECTRON__", { shell: { openExternal: async (url: string) => { opened.push(url); } } });
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    const open = spyOn(window, "open").mockReturnValue(null);
    expect(await tryOpenBrowserAuthUrl(auth, true)).toBe(true);
    expect(opened).toEqual([auth]);
    expect(assign).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    assign.mockRestore();
    open.mockRestore();
  });

  test("off and non-gateway callers retain the existing browser-open behavior", async () => {
    const open = spyOn(window, "open").mockReturnValue(null);
    expect(await tryOpenBrowserAuthUrl(auth)).toBe(false);
    expect(open).toHaveBeenCalledWith(auth, "_blank");
    open.mockRestore();
  });
});
