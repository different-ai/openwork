import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { SignInMethod } from "../app/(den)/dashboard/_components/connector-setup";
import type { McpRequirementsDiscovery } from "../app/(den)/dashboard/_components/mcp-connections-data";
import type { SetupCheck } from "../app/(den)/dashboard/_components/setup-checks";

// React DOM decides at import time whether typing fires onChange, so the DOM comes first.
GlobalRegistrator.register({ url: "https://app.example.test" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
const navigation = await import("next/navigation");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectorPicker } = await import("../app/(den)/dashboard/_components/connector-picker");
const { signInMethod, signInMethodSentence } = await import("../app/(den)/dashboard/_components/connector-setup");
const { changeAddressHref, withCheckActions } = await import("../app/(den)/dashboard/_components/connector-setup-screen");
const { SetupChecks } = await import("../app/(den)/dashboard/_components/setup-checks");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mock.restore();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function link(label: string) {
  return [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === label) ?? null;
}

function input(label: string) {
  const found = container.querySelector(`input[aria-label="${label}"]`);
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing ${label} input`);
  return found;
}

const target = { name: "Acme", url: "https://mcp.example.com/mcp", description: "" };
const catalog = "/o/workspace/library/connectors/new";

const methods: Array<[McpRequirementsDiscovery["authentication"]["kind"], McpRequirementsDiscovery["status"], SignInMethod]> = [
  ["none", "ready", "none"],
  ["oauth", "ready", "oauth"],
  ["oauth", "manual_action_required", "admin_setup"],
  ["manual_bearer", "manual_action_required", "key"],
  ["unknown", "unsupported", "unknown"],
];

test.each(methods)("a %s server Den calls %s signs in with %s", (kind, status, method) => {
  expect(signInMethod({ status, authentication: { kind } })).toBe(method);
});

test("an OAuth server OpenWork cannot register with does not pass as ready to sign in", () => {
  expect(signInMethodSentence("Acme", "oauth")).toBe("You sign in with your own Acme account.");
  expect(signInMethodSentence("Acme", "admin_setup")).toBe("An admin has to register OpenWork with Acme first.");
});

test("only an address someone typed can be changed", () => {
  expect(changeAddressHref(catalog, "custom", target)).toBe(`${catalog}?name=Acme&url=https%3A%2F%2Fmcp.example.com%2Fmcp`);
  expect(changeAddressHref(catalog, "slack", target)).toBeNull();
});

test("each failed check offers its way forward on the row", async () => {
  const failed = (id: string): SetupCheck => ({ id, title: id, description: "", status: "failed" });
  const changeAddress = changeAddressHref(catalog, "custom", target);
  await render(<SetupChecks checks={withCheckActions(
    { checks: [failed("find"), failed("sign-in-method")], canSignIn: false, startSignIn: async () => {} },
    { name: "Acme", changeAddress, advancedSetup: "/o/workspace/mcp-connections/all" },
  )} />);
  expect(link("Change address")?.getAttribute("href")).toBe(changeAddress);
  expect(link("Advanced setup")?.getAttribute("href")).toBe("/o/workspace/mcp-connections/all");

  await render(<SetupChecks checks={withCheckActions(
    { checks: [failed("sign-in-method")], canSignIn: false, startSignIn: async () => {} },
    { name: "Acme", changeAddress: null },
  )} />);
  expect(container.querySelectorAll("a")).toHaveLength(0);
});

test("the sign-in check carries the sign-in button once OpenWork knows how", async () => {
  const startSignIn = mock(async () => {});
  await render(<SetupChecks checks={withCheckActions(
    { checks: [{ id: "sign-in", title: "Sign in to Acme", description: "", status: "current" }], canSignIn: true, startSignIn },
    { name: "Acme", changeAddress: null },
  )} />);
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Sign in with Acme");
  await act(async () => button?.click());
  expect(startSignIn).toHaveBeenCalledTimes(1);
});

test("Change address reopens the address form as typed, and Continue checks the fixed address", async () => {
  const pushes: string[] = [];
  spyOn(navigation, "useRouter").mockReturnValue({
    push(href) { pushes.push(href); }, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: async () => {}, bfcacheId: "fixture",
  });
  await render(
    <ConnectorPicker
      entries={[]}
      loading={false}
      addHref={() => catalog}
      customHref={(typed) => `${catalog}/custom?${new URLSearchParams(typed).toString()}`}
      initialCustom={{ name: "Acme", url: "https://mcp.example.com/mpc" }}
    />,
  );
  expect(input("Address").value).toBe("https://mcp.example.com/mpc");
  expect(input("Name").value).toBe("Acme");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input("Address"), target.url);
    input("Address").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(pushes).toEqual([`${catalog}/custom?name=Acme&url=https%3A%2F%2Fmcp.example.com%2Fmcp`]);
});
