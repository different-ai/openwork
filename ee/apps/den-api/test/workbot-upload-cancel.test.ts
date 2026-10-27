import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadWorkbotFile } from "../../../packages/workbot-ui/src/data.ts";
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host.ts";

test("removing an upload while request preparation is pending never starts its transfer", async () => {
  const controller = new AbortController();
  setWorkbotHost({
    user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/",
    requestJson: async () => ({ response: new Response(), payload: null }),
    prepare: async () => {
      controller.abort();
      return { url: "http://127.0.0.1/files", headers: new Headers(), credentials: "omit" };
    },
  });
  // No XMLHttpRequest exists in Node: reaching transfer creation would fail with a different error.
  await assert.rejects(uploadWorkbotFile(new File(["notes"], "notes.txt"), () => {}, controller.signal, null), { message: "Canceled." });
});
