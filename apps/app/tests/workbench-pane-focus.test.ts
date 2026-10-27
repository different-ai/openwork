import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
const { focusPaneComposerSoon } = await import("../src/react-app/domains/session/chat/workbench-pane-focus");
afterAll(async () => { await GlobalRegistrator.unregister(); });
const frames = (count: number) => new Promise<void>((resolve) => {
  let left = count;
  const tick = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

function editor() {
  const element = document.createElement("div");
  element.setAttribute("contenteditable", "true");
  element.setAttribute("data-composer-editor", "");
  return element;
}

test("a new side chat's composer gets the cursor once it mounts, not the main one", async () => {
  document.body.innerHTML = '<div data-workbench-pane="primary"></div><div data-workbench-pane="secondary"></div>';
  const main = editor();
  document.querySelector('[data-workbench-pane="primary"]')?.append(main);
  main.focus();

  focusPaneComposerSoon("secondary");
  await frames(3);
  const side = editor();
  document.querySelector('[data-workbench-pane="secondary"]')?.append(side);
  await frames(3);

  expect(document.activeElement).toBe(side);
});

test("cancelling leaves focus alone", async () => {
  document.body.innerHTML = '<div data-workbench-pane="secondary"></div>';
  const cancel = focusPaneComposerSoon("secondary");
  cancel();
  const side = editor();
  document.querySelector('[data-workbench-pane="secondary"]')?.append(side);
  await frames(3);
  expect(document.activeElement).not.toBe(side);
});
