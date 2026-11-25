import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertAbsent, locate } from "../packages/cdp/src/input.ts";
import { evaluateOnSurface } from "../packages/cdp/src/surface.ts";
import { chrome } from "../packages/hosts/src/browser.ts";
import { createLocalHost } from "../packages/hosts/src/local.ts";

// Named explicitly: this regression test requires an installed Chrome binary.
test("dialog targets find explicit and native dialogs without treating hidden dialogs as visible", async () => {
  await using host = createLocalHost({ repoRoot: fileURLToPath(new URL("../../", import.meta.url)), log: () => {} });
  await using surface = await chrome({ host, headless: true });
  await surface.client.send("Page.navigate", {
    url: `data:text/html,${encodeURIComponent(`<!doctype html>
      <style>[role="dialog"] { width: 240px; height: 80px; }</style>
      <div role="dialog" aria-label="Hidden first" hidden>Hidden first</div>
      <div style="display:none"><div role="dialog" aria-label="Hidden parent">Hidden parent</div></div>
      <div role="dialog" aria-label="Invisible" style="visibility:hidden">Invisible</div>
      <div role="dialog" aria-label="Transparent" style="opacity:0">Transparent</div>
      <dialog aria-label="Closed native">Closed native</dialog>
      <div role="dialog" aria-labelledby="explicit-title"><h2 id="explicit-title">Explicit dialog</h2></div>
      <dialog open aria-label="Native dialog">Native content</dialog>
    `)}`,
  });
  // Page.navigate can return before the new document's load completes.
  await evaluateOnSurface(surface, () => new Promise<void>((resolve) => {
    if (document.readyState === "complete") resolve();
    else addEventListener("load", () => resolve(), { once: true });
  }));

  const explicit = await locate(surface, { role: "dialog", label: "Explicit dialog" });
  expect(explicit).toMatchObject({ tag: "div", name: "Explicit dialog", visible: true });
  const native = await locate(surface, { role: "dialog", label: "Native dialog" });
  expect(native).toMatchObject({ tag: "dialog", name: "Native dialog", visible: true });
  expect(await locate(surface, { role: "dialog" })).toMatchObject({ name: "Explicit dialog", visible: true });
  expect(await locate(surface, { role: "dialog", nth: 1 })).toMatchObject({ name: "Native dialog", visible: true });
  await expect(assertAbsent(surface, { role: "dialog" }, 20)).rejects.toThrow("Target remained visible");

  for (const label of ["Hidden first", "Hidden parent", "Invisible", "Transparent", "Closed native"]) {
    expect(await locate(surface, { role: "dialog", label })).toMatchObject({ visible: false });
    await assertAbsent(surface, { role: "dialog", label }, 20);
  }
});
