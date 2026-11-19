/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, useEffect, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RetainedArtifactSurface } = await import("../src/react-app/domains/dashboard/retained-artifact-surface");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let mounts = 0;
let unmounts = 0;
function Witness() {
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
  return <button onClick={() => setReviewed(true)}>{reviewed ? "Reviewed" : "Mark reviewed"}</button>;
}
async function render(active: boolean, scope = "member-org-deployment", enabled = true) {
  await act(async () => root.render(enabled ? <RetainedArtifactSurface key={scope} active={active}><Witness /></RetainedArtifactSurface> : null));
}
beforeEach(() => {
  mounts = 0; unmounts = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

test("does not mount or run artifacts before the person visits", async () => {
  await render(false);
  expect(mounts).toBe(0);
  expect(host.querySelector("button")).toBeNull();
});
test("navigation hides and inerts the artifact without losing its interaction state", async () => {
  await render(true);
  const firstButton = host.querySelector("button");
  await act(async () => firstButton?.click());
  await render(false);
  expect(host.firstElementChild?.hasAttribute("hidden")).toBe(true);
  expect(host.firstElementChild?.hasAttribute("inert")).toBe(true);
  expect(host.querySelector("button")).toBe(firstButton);
  await render(true);
  expect(host.firstElementChild?.hasAttribute("hidden")).toBe(false);
  expect(host.textContent).toBe("Reviewed");
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
});
test("a different verified member, organization or deployment discards retained content", async () => {
  await render(true);
  await render(false, "another-member-org-deployment");
  expect(unmounts).toBe(1);
  expect(host.querySelector("button")).toBeNull();
  await render(true, "another-member-org-deployment");
  expect(host.textContent).toBe("Mark reviewed");
  expect(mounts).toBe(2);
});
test("losing verified access tears down the retained frame", async () => {
  await render(true);
  await render(false, "member-org-deployment", false);
  expect(unmounts).toBe(1);
  expect(host.childElementCount).toBe(0);
});
