import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register({ url: "https://app.example.test/setup" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const { default: SetupPage } = await import("../app/(den)/setup/page");
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let signupBodies: unknown[];

async function fill(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing input: ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing setup form");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

beforeEach(async () => {
  signupBodies = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("bootstrap/status")) return Response.json({ status: "available" });
    if (url.includes("bootstrap/verify")) return Response.json({ grant: "test-bootstrap-grant" });
    if (url.includes("sign-up/email")) {
      signupBodies.push(JSON.parse(String(init?.body)));
      // Keep the component mounted so this test can inspect the submitted body.
      return Response.json({ message: "Test server rejection" }, { status: 400 });
    }
    return Response.json({});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SetupPage />));
  await fill("setup-email", "admin@example.test");
  await fill("setup-code", "test-setup-code");
  await submit();
  await fill("setup-name", "Administrator");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mock.restore();
});
afterAll(async () => GlobalRegistrator.unregister());

test("mismatched passwords never send signup; corrected confirmation sends only the password", async () => {
  await fill("setup-password", "CorrectPassword123!");
  await fill("setup-confirm-password", "DifferentPassword123!");
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Passwords do not match. Re-enter your confirmation password.");
  expect(signupBodies).toEqual([]);
  await fill("setup-confirm-password", "CorrectPassword123!");
  await submit();
  expect(signupBodies).toEqual([{ email: "admin@example.test", name: "Administrator", password: "CorrectPassword123!", bootstrapGrant: "test-bootstrap-grant" }]);
});

test("the submit handler rejects short passwords even when native validation is bypassed", async () => {
  await fill("setup-password", "short");
  await fill("setup-confirm-password", "short");
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Use at least 8 characters for your password.");
  expect(signupBodies).toEqual([]);
  expect(container.querySelector<HTMLInputElement>("#setup-password")?.minLength).toBe(8);
});

test("passwords start hidden and visibility toggles both fields without submitting or changing values", async () => {
  await fill("setup-password", "CorrectPassword123!");
  await fill("setup-confirm-password", "CorrectPassword123!");
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-controls="setup-password setup-confirm-password"]');
  if (!toggle) throw new Error("Missing visibility control");
  for (const [pressed, type] of [[false, "password"], [true, "text"], [false, "password"]]) {
    if (toggle.getAttribute("aria-pressed") !== String(pressed)) await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe(String(pressed));
    for (const id of ["setup-password", "setup-confirm-password"]) {
      const input = container.querySelector<HTMLInputElement>(`#${id}`);
      expect(input?.type).toBe(type);
      expect(input?.value).toBe("CorrectPassword123!");
      expect(input?.autocomplete).toBe("new-password");
    }
  }
  expect(signupBodies).toEqual([]);
});
