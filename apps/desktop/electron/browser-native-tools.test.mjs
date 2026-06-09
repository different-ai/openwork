import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeBuiltinServer,
  evaluateScriptCallFunctionOptions,
  SCREENSHOT_FORMATS,
} from "./browser-native-tools.mjs";

test("screenshot formats match Electron NativeImage encoders", () => {
  assert.deepEqual(SCREENSHOT_FORMATS, ["png", "jpeg"]);
});

test("evaluate script passes every snapshot argument as a function parameter", () => {
  const options = evaluateScriptCallFunctionOptions("(first, second) => first.id + second.id", ["object-1", "object-2"]);

  assert.equal(options.objectId, "object-1");
  assert.deepEqual(options.arguments, [{ objectId: "object-1" }, { objectId: "object-2" }]);
  assert.equal(options.returnByValue, true);
  assert.match(options.functionDeclaration, /fn\.apply\(args\[0\] \?\? this, args\)/);
});

test("page management tools use provided tab callbacks", async () => {
  const tabs = [
    { tabId: "tab-1", url: "https://example.test/one", title: "One", isActive: true, isLoading: false, canGoBack: false, canGoForward: false },
    { tabId: "tab-2", url: "https://example.test/two", title: "Two", isActive: false, isLoading: false, canGoBack: true, canGoForward: false },
  ];
  const calls = [];
  const server = createNativeBuiltinServer({
    getWebContents: () => ({ isDestroyed: () => false }),
    listTabs: () => tabs,
    createTab: async (url) => {
      calls.push(["create", url]);
      return "tab-3";
    },
    selectTab: async (tabId) => {
      calls.push(["select", tabId]);
      return tabId;
    },
    closeTab: async (tabId) => {
      calls.push(["close", tabId]);
      return tabId;
    },
  });

  const pages = await server._registeredTools.list_pages.handler({});
  assert.deepEqual(JSON.parse(pages.content[0].text).map((page) => page.pageId), ["tab-1", "tab-2"]);

  await server._registeredTools.select_page.handler({ pageId: 2 });
  await server._registeredTools.create_page.handler({ url: "https://example.test/three" });
  await server._registeredTools.close_page.handler({ pageId: "tab-1" });

  assert.deepEqual(calls, [
    ["select", "tab-2"],
    ["create", "https://example.test/three"],
    ["close", "tab-1"],
  ]);
});
