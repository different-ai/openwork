import assert from "node:assert/strict";
import test from "node:test";

import {
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
