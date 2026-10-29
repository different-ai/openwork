import { expect, test } from "vitest";
import { attachFiles } from "./input.ts";
import type { Surface } from "./surface.ts";

function picker(nodeIds: number[], unavailable: string | null = null) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const surface: Surface = {
    handle: { name: "file-picker", kind: "chrome", hostKind: "local", cdpUrl: "http://127.0.0.1:1" },
    client: {
      close() {},
      async send(method, params) {
        calls.push({ method, params });
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelectorAll") return { nodeIds };
        if (method === "Runtime.evaluate") return { result: { objectId: "page" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: unavailable } };
        return {};
      },
    },
  };
  return { surface, calls };
}

test("file selection uses the native input path, not application state or synthetic change events", async () => {
  const { surface, calls } = picker([4]);
  await attachFiles(surface, 'input[type="file"]', ["/fixtures/notes.txt"]);
  expect(calls.map(call => call.method)).toEqual(["DOM.getDocument", "DOM.querySelectorAll", "Runtime.evaluate", "Runtime.callFunctionOn", "DOM.setFileInputFiles"]);
  expect(calls.at(-1)).toEqual({ method: "DOM.setFileInputFiles", params: { nodeId: 4, files: ["/fixtures/notes.txt"] } });
});

test("an unavailable picker is rejected before native file dispatch", async () => {
  for (const unavailable of ["disabled", "unavailable parent surface", "not an available file input"]) {
    const { surface, calls } = picker([4], unavailable);
    await expect(attachFiles(surface, 'input[type="file"]', ["/fixtures/notes.txt"])).rejects.toThrow(`File input unavailable: ${unavailable}`);
    expect(calls.some(call => call.method === "DOM.setFileInputFiles")).toBe(false);
  }
});

test("ambiguous or missing inputs do not select files on the wrong composer", async () => {
  for (const nodes of [[], [4, 5]]) {
    const { surface, calls } = picker(nodes);
    await expect(attachFiles(surface, 'input[type="file"]', ["/fixtures/notes.txt"])).rejects.toThrow("Expected one file input");
    expect(calls.some(call => call.method === "DOM.setFileInputFiles")).toBe(false);
  }
});
