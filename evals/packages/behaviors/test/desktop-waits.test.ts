import assert from "node:assert/strict";
import test from "node:test";

import { waitFor } from "../src/desktop.ts";
import type { CdpClient, Surface } from "@openwork/cdp";

function fakeSurface(valueForExpression: (expression: string) => unknown): Surface {
  const client: CdpClient = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      const expression = typeof params.expression === "string" ? params.expression : "";
      return { result: { value: valueForExpression(expression) } };
    },
    close() {},
  };
  return {
    handle: {
      name: "fake",
      kind: "electron",
      hostKind: "test",
      cdpUrl: "http://127.0.0.1:1",
    },
    client,
  };
}

function isScreenDump(expression: string): boolean {
  return expression.includes("document.title") && expression.includes("querySelectorAll(\"button\")");
}

test("waitFor has a finite default timeout", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const surface = fakeSurface((expression) => {
    if (isScreenDump(expression)) {
      return { hash: "#/still-here", route: "/still-here", title: "Waiting", buttons: [], body: "Not ready" };
    }
    context.mock.timers.setTime(30_001);
    return false;
  });

  await assert.rejects(waitFor(surface, "false"), /Timed out after 30000ms waiting for false/);
});

test("waitFor appends a bounded on-screen dump to timeout failures", async () => {
  const surface = fakeSurface((expression) => isScreenDump(expression)
    ? {
      hash: "#/workspace/demo/extensions",
      route: "/workspace/demo/extensions",
      title: "OpenWork",
      buttons: ["Back", "Add extension"],
      body: "Extensions Add an extension to this workspace",
    }
    : false);

  await assert.rejects(
    waitFor(surface, "false", { timeoutMs: 1, label: "extensions route" }),
    /On screen: \{"hash":"#\/workspace\/demo\/extensions","route":"\/workspace\/demo\/extensions","title":"OpenWork","buttons":\["Back","Add extension"\],"body":"Extensions Add an extension to this workspace"\}/,
  );
});

test("waitFor still reports timeout context when the on-screen dump fails", async () => {
  const surface = fakeSurface((expression) => {
    if (isScreenDump(expression)) throw new Error("renderer unavailable");
    return false;
  });

  await assert.rejects(
    waitFor(surface, "false", { timeoutMs: 1, label: "extensions route" }),
    /Timed out after 1ms waiting for extensions route.*On screen: unavailable/,
  );
});
